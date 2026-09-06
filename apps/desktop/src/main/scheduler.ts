import { zeroUsage, type AgentEvent } from "@repo/agent-driver/events";
import * as store from "@/main/store/store";
import { publishActivity } from "@/main/activity";
import { agentDriver, type RunResult } from "@/main/agents/agent-driver";
import type { RunToolHooks } from "@/main/control-plane";
import { errorMessage } from "@/shared/errors";
import {
  approvalAnswer,
  autonomousBrief,
  founderPing,
  integrationConnectedAnswer,
  roomTranscript,
  routineBrief,
  runPreamble,
  type TaskBrief,
} from "@/main/prompts/briefs";
import { MAX_TASK_ATTEMPTS, isOutOfBudget, resolveMentions, spriteSeedFor } from "@/shared/domain";
import type {
  Company,
  Employee,
  IntegrationKind,
  Product,
  Task,
  TaskPriority,
  TaskStatus,
} from "@/shared/domain";

const GLOBAL_CONCURRENCY_CAP = 3;

// Reserve capacity for founder requests; queued priority cannot preempt a live run.
const FOUNDER_RESERVED_SLOTS = 1;
const BACKGROUND_CAPACITY = GLOBAL_CONCURRENCY_CAP - FOUNDER_RESERVED_SLOTS;

const AUTOPILOT_TICK_MS = 10_000;

const isWorking = (employeeId: string): boolean =>
  store.getEmployee(employeeId)?.status === "working";

class Scheduler {
  private active = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.onTick(), AUTOPILOT_TICK_MS);
    this.onTick();
  }

  // Retry queued work even with autopilot off.
  private onTick(): void {
    this.tick();
    this.tickAutopilot();
  }

  /** Stop scheduling; in-flight runs settle on their own. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private admit(company: Company): boolean {
    if (!isOutOfBudget(company)) return true;
    this.haltForBudget(company);
    return false;
  }

  /** Pause autopilot at the cap; running turns finish and report their cost. */
  haltForBudget(company: Company, spentUsd = company.spentUsd): void {
    if (!company.autopilot) return;
    store.setAutopilot(company.id, false);
    publishActivity({
      kind: "budget.exhausted",
      payload: { spentUsd, budget: company.budget },
    });
  }

  private fireDueRoutines(company: Company, employees: Employee[]): void {
    const now = Date.now();
    for (const r of store.listRoutines(company.id)) {
      if (this.active.size >= BACKGROUND_CAPACITY) break;
      if (r.lastRunAt !== null && now - r.lastRunAt < r.intervalHours * 3_600_000) continue;
      const idle = employees.filter((e) => e.status === "idle");
      const assignee =
        (r.role !== null &&
          idle.find((e) => `${e.role} ${e.title}`.toLowerCase().includes(r.role ?? ""))) ||
        idle[0];
      if (!assignee) continue;
      store.markRoutineRun(company.id, r.id);
      // a routine is about the company, but its work lands on a product:
      // the one waited on longest, like autopilot's own turn
      this.brief(
        company,
        assignee,
        routineBrief(r),
        store.attentionProduct(company.id)?.id ?? null,
      );
    }
  }

  private brief(
    company: Company,
    emp: Employee,
    brief: TaskBrief,
    productId: string | null,
    priority: TaskPriority = "medium",
  ): Task {
    const task = store.createTask({
      companyId: company.id,
      productId,
      ...brief,
      priority,
      assigneeId: emp.id,
    });
    this.tryAssign(task.id, emp.id);
    return task;
  }

  private tickAutopilot(): void {
    if (this.stopped) return;
    const company = store.getDefaultCompany();
    if (!company || !company.autopilot || !this.admit(company)) return;
    const employees = store.listEmployees(company.id);
    this.fireDueRoutines(company, employees);
    for (const emp of employees) {
      if (this.active.size >= BACKGROUND_CAPACITY) break;
      if (emp.status !== "idle") continue;
      if (agentDriver.restingRunner(emp.runner) !== null) continue;
      const open = store
        .openTasksFor(emp.id)
        .some((t) => t.state.kind === "queued" || t.state.kind === "running");
      if (open) continue;
      const focus = store.attentionProduct(company.id);
      this.brief(
        company,
        emp,
        this.autonomousBrief(company, emp, employees, focus),
        focus?.id ?? null,
      );
    }
  }

  /** Gather what the heartbeat brief is grounded in; the prompt module phrases it. */
  private autonomousBrief(
    company: Company,
    emp: Employee,
    employees: Employee[],
    focus: Product | null,
  ): TaskBrief {
    return autonomousBrief({
      company,
      employee: emp,
      employees,
      products: store.listProducts(company.id),
      focus,
      room: store.recentTeamMessages(company.id, 12),
      ships: store.recentActivity(company.id, "ship", 6).map((s) => s.message),
      problems: store
        .listOpenTasks(company.id)
        .filter((t) => t.state.kind === "dead")
        .slice(0, 5),
      nameOf: (id) => this.empName(id),
    });
  }

  private empName(id: string): string {
    return store.getEmployee(id)?.name ?? "someone";
  }

  private hooksFor(
    emp: Employee,
    company: Company,
    run: { runId: string; taskId: string; productId: string | null },
  ): RunToolHooks {
    const isLeader = company.leaderId === emp.id;

    const post = (text: string, to: string | null = null): void => {
      store.postTeamMessage(company.id, emp.id, text);
      publishActivity({ employeeId: emp.id, kind: "chat", message: text, payload: { to } });
    };

    return {
      messageTeam: (text: string): void => post(text.slice(0, 400)),
      readTeam: (): string =>
        roomTranscript(store.recentTeamMessages(company.id, 15), (id) => this.empName(id)),
      delegate: (role: string, title: string, description: string, product: string | null) => {
        const productId =
          product ?? run.productId ?? store.attentionProduct(company.id)?.id ?? null;
        if (productId !== null && store.getProduct(productId)?.companyId !== company.id) {
          return `No product "${productId}" here — the products are ${store
            .listProducts(company.id)
            .map((p) => p.id)
            .join(", ")}.`;
        }
        const want = role.toLowerCase();
        const pool = store.listEmployees(company.id).filter((e) => e.id !== emp.id);
        const matches = (e: Employee): boolean =>
          e.role.toLowerCase() === want || e.title.toLowerCase().includes(want);
        const mate = pool.find(matches);
        if (!mate) {
          post(`(no "${role}" to delegate "${title}" to)`);
          return `No teammate matches the role "${role}" — do it yourself or pick another role.`;
        }
        const t = store.createTask({
          companyId: company.id,
          productId,
          title,
          description,
          priority: "medium",
          assigneeId: mate.id,
        });
        post(`→ ${mate.name} (${mate.title}): ${title}`, mate.id);
        this.tryAssign(t.id, mate.id);
        return `Delegated "${title}" to ${mate.name} (${mate.title}). They'll report back in the team room.`;
      },
      createProduct: (name: string, description: string): string => {
        if (!isLeader) return "Only the team lead can start a product — raise it in the team room.";
        const product = store.createProduct({ companyId: company.id, name, description });
        publishActivity({
          employeeId: emp.id,
          kind: "product.created",
          message: product.name,
          payload: { productId: product.id },
        });
        post(`🆕 New product: ${product.name} — ${product.description}`);
        return `Created "${product.name}" (${product.id}); its workspace is ${product.workspaceDir}. Delegate work to it with "product":"${product.id}".`;
      },
      hire: ({ role, title, name, persona }): string => {
        if (!isLeader) return "Only the team lead can hire — raise it in the team room.";
        const all = store.listEmployees(company.id);
        const hireName = name ?? `${title} ${all.length + 1}`;
        let hired: Employee;
        try {
          hired = store.createEmployee({
            companyId: company.id,
            name: hireName,
            role,
            title,
            persona: persona ?? `A focused, pragmatic ${title} who ships.`,
            runner: agentDriver.pickRunner(all.length),
            spriteSeed: spriteSeedFor(role, hireName),
            deskIndex: all.length,
          });
        } catch (err) {
          return `Couldn't hire: ${errorMessage(err)}. Release someone first or work with the team you have.`;
        }
        post(`🤝 hired ${hired.name} (${title})`);
        publishActivity({
          employeeId: hired.id,
          kind: "org.hired",
          payload: { by: emp.id, name: hired.name, title },
        });
        return `Hired ${hired.name} (${title}) — slug "${hired.id}". They start picking up work autonomously; delegate to them right away if you have something specific.`;
      },
      release: (slug, reason): string => {
        if (!isLeader) return "Only the team lead can release teammates.";
        if (slug === emp.id) return "You can't release yourself.";
        const target = store.getEmployee(slug);
        if (!target || target.companyId !== company.id) {
          return `No teammate with slug "${slug}" — check the roster in your brief.`;
        }
        if (isWorking(slug)) {
          return `${target.name} is mid-task right now — try again when they're idle.`;
        }
        agentDriver.disposeEmployee(slug);
        store.archiveEmployee(slug);
        post(`👋 ${target.name} was released${reason ? ` — ${reason}` : ""}`);
        publishActivity({
          employeeId: target.id,
          kind: "org.released",
          payload: { by: emp.id, name: target.name, reason },
        });
        return `Released ${target.name}. Their workspace contributions and memory are archived under alumni/.`;
      },
      // The task only turns `blocked` when the run settles, but the ask exists
      // now — so the office raises the "!" over the employee's head at once.
      raiseAsk: (ask): void => {
        publishActivity({
          runId: run.runId,
          taskId: run.taskId,
          employeeId: emp.id,
          kind: "run.ask",
          payload: { ask },
        });
      },
    };
  }

  /** Whole-token @slug or @first-name mentions wake the addressed employees. */
  founderMessage(companyId: string, text: string): void {
    this.say(companyId, text, null);
    for (const employeeId of resolveMentions(text, store.listEmployees(companyId))) {
      this.wakeEmployee(employeeId, founderPing(text));
    }
  }

  private say(companyId: string, line: string, to: string | null): void {
    store.postTeamMessage(companyId, null, line);
    publishActivity({ kind: "chat", message: line.slice(0, 400), payload: { to } });
  }

  /** Direct requests wake the employee without relying on mention parsing. */
  directEmployee(employeeId: string, instruction: string): void {
    const emp = store.getEmployee(employeeId);
    if (!emp) throw new Error(`no employee ${employeeId}`);
    this.say(emp.companyId, `@${emp.id} ${instruction}`, emp.id);
    this.wakeEmployee(employeeId, founderPing(instruction));
  }

  private ship(
    task: Task,
    at: { runId: string; taskId: string; employeeId: string },
    summary: string,
  ): void {
    store.recordShip(task.companyId, task.productId);
    publishActivity({ ...at, kind: "ship", message: (summary || "shipped work").slice(0, 200) });
    const ships = store.getCompany(task.companyId)?.ships ?? 0;
    if (ships > 0 && ships % 10 === 0) {
      store.postTeamMessage(
        task.companyId,
        null,
        `🎉 Milestone: ${ships} things shipped — keep going!`,
      );
    }
  }

  private resumeBlocked(taskId: string, answer: string, whenNotBlocked: string): Task {
    const continuation = store.resolveBlockedWithAnswer(taskId, answer);
    if (!continuation || !continuation.assigneeId) throw new Error(whenNotBlocked);
    return this.assign(continuation.id, continuation.assigneeId);
  }

  answerQuestion(taskId: string, answer: string): Task {
    return this.resumeBlocked(taskId, answer, "task is not awaiting an answer");
  }

  resolveApproval(taskId: string, approved: boolean): Task {
    const task = store.getTask(taskId);
    if (!task || task.state.kind !== "blocked" || task.state.ask.type !== "approval")
      throw new Error("task is not awaiting an approval");
    // Record before resuming: the agent's retry hits the hook again, and it
    // must find the sign-off already there.
    if (approved) store.grantApproval(task.companyId, task.state.ask.command);
    return this.resumeBlocked(taskId, approvalAnswer(approved), "could not resume the task");
  }

  resumeIntegrationAsks(kind: IntegrationKind): void {
    const company = store.getDefaultCompany();
    if (!company) return;
    for (const task of store.listOpenTasks(company.id)) {
      const st = task.state;
      if (st.kind !== "blocked" || st.ask.type !== "integration") continue;
      if (st.ask.integration !== kind) continue;
      const continuation = store.resolveBlockedWithAnswer(
        task.id,
        integrationConnectedAnswer(kind),
      );
      if (continuation?.assigneeId) this.tryAssign(continuation.id, continuation.assigneeId);
    }
  }

  /** Coalesce identical requests still waiting for the same employee. */
  wakeEmployee(employeeId: string, brief: TaskBrief): Task | null {
    const emp = store.getEmployee(employeeId);
    if (!emp) return null;
    const company = store.getCompany(emp.companyId);
    if (!company || !this.admit(company)) return null;
    const waiting = store
      .openTasksFor(employeeId)
      .find(
        (t) =>
          t.description === brief.description &&
          (t.state.kind === "queued" || t.state.kind === "todo"),
      );
    return (
      waiting ??
      this.brief(company, emp, brief, store.productOfEmployee(emp.id)?.id ?? null, "high")
    );
  }

  /** Assign, tolerating a busy assignee — the queue picks it up next tick. */
  private tryAssign(taskId: string, employeeId: string): void {
    try {
      this.assign(taskId, employeeId);
    } catch {
      /* claim race or busy — retried on a later tick */
    }
  }

  /** Claim even at the budget cap so answered continuations remain queued. */
  assign(taskId: string, employeeId: string): Task {
    const claimed = store.claimTask(taskId, employeeId);
    if (!claimed) throw new Error("task is not assignable");
    publishActivity({ taskId, employeeId, kind: "status", message: "queued" });
    this.tick();
    return store.getTask(taskId) ?? claimed;
  }

  tick(): void {
    if (this.stopped) return;
    // Visit each candidate once: a rejected start must not spin on the same task.
    for (const task of store.listQueuedTasks()) {
      if (this.active.size >= GLOBAL_CONCURRENCY_CAP) break;
      if (this.active.size >= BACKGROUND_CAPACITY && task.priority !== "high") continue;
      if (task.assigneeId === null || isWorking(task.assigneeId)) continue;
      const employee = store.getEmployee(task.assigneeId);
      if (!employee || agentDriver.restingRunner(employee.runner) !== null) continue;
      this.startRun(task);
    }
  }

  private startRun(task: Task): void {
    if (this.stopped) return;
    const employeeId = task.assigneeId;
    if (!employeeId) return;
    const employee = store.getEmployee(employeeId);
    const company = store.getCompany(task.companyId);
    if (!employee || !company) return;
    // Check again at the spawn boundary: queued work may predate the budget cap.
    if (!this.admit(company)) return;

    const runId = crypto.randomUUID();
    const locked = store.lockTaskForRun(task.id, runId);
    if (!locked) return; // lost race

    store.setEmployeeStatus(employeeId, "working");
    this.active.add(runId);
    const at = { runId, taskId: task.id, employeeId };
    publishActivity({ ...at, kind: "run.start" });
    publishActivity({ ...at, kind: "status", message: "running" });

    void this.execute(runId, task, employee, company)
      .catch((cause: unknown) => {
        this.finish(runId, task, employee, {
          outcome: { kind: "failed", error: errorMessage(cause) },
          summary: "",
          session: employee.sessionId,
          usage: zeroUsage(),
        });
      })
      .finally(() => {
        this.active.delete(runId);
        this.tick();
      });
  }

  private async execute(runId: string, task: Task, emp: Employee, company: Company): Promise<void> {
    const product = task.productId === null ? null : store.getProduct(task.productId);
    const result = await agentDriver.runTask(
      emp,
      company,
      {
        title: task.title,
        description: `${runPreamble(product, company)}\n\n${task.description ?? ""}`.trim(),
        workspace: product?.workspaceDir ?? company.workspaceDir,
      },
      (ev: AgentEvent) => this.onAgentEvent(runId, task, emp, ev),
      this.hooksFor(emp, company, { runId, taskId: task.id, productId: task.productId }),
    );
    this.finish(runId, task, emp, result);
  }

  private onAgentEvent(runId: string, task: Task, emp: Employee, ev: AgentEvent): void {
    const at = { runId, taskId: task.id, employeeId: emp.id };
    switch (ev.type) {
      case "tool_start":
        publishActivity({
          ...at,
          kind: "tool_call",
          message: ev.toolName,
          payload: { kind: ev.kind, args: ev.args },
        });
        break;
      case "message_end":
        if (ev.text) publishActivity({ ...at, kind: "message", message: ev.text.slice(0, 2000) });
        break;
      default:
        break;
    }
  }

  /** Usage limits park the runner without consuming a task retry. */
  private finish(runId: string, task: Task, emp: Employee, r: RunResult): void {
    const at = { runId, taskId: task.id, employeeId: emp.id };
    const o = r.outcome;
    let status: TaskStatus;
    switch (o.kind) {
      case "blocked":
        status = "blocked";
        store.settleTask(task.id, runId, {
          kind: "blocked",
          ask: o.ask,
          summary: r.summary || null,
        });
        break;
      case "done":
        status = "done";
        store.settleTask(task.id, runId, { kind: "done", summary: r.summary || null });
        this.ship(task, at, r.summary);
        break;
      case "resting":
        status = "queued";
        store.parkTask(task.id, runId, o.until, o.error);
        publishActivity({
          ...at,
          kind: "runner.resting",
          payload: { runner: emp.runner, until: o.until },
        });
        break;
      case "failed": {
        const verdict = store.failTask(task.id, runId, o.error);
        if (verdict?.kind === "dead") {
          status = "dead";
          publishActivity({
            ...at,
            kind: "task.dead",
            payload: { attempts: verdict.attempts, error: o.error },
          });
        } else {
          status = "queued";
          if (verdict) {
            publishActivity({
              ...at,
              kind: "task.retry",
              payload: {
                attempts: verdict.attempts,
                maxAttempts: MAX_TASK_ATTEMPTS,
                retryAt: verdict.retryAt,
                error: o.error,
              },
            });
          }
        }
        break;
      }
    }

    store.setEmployeeStatus(emp.id, "idle");
    store.setEmployeeSession(emp.id, r.session);

    if (r.usage.costUsd > 0) {
      const before = store.getCompany(task.companyId);
      const after = store.recordSpend(task.companyId, r.usage.costUsd);
      if (before && after && !isOutOfBudget(before) && isOutOfBudget(after)) {
        this.haltForBudget(after);
      }
    }

    publishActivity({ ...at, kind: "status", message: status });
    publishActivity({
      ...at,
      kind: "run.end",
      payload: { summary: r.summary, outcome: o, costUsd: r.usage.costUsd },
    });
  }
}

export const scheduler = new Scheduler();
