import { zeroUsage } from "@repo/agent-driver/events";
import type { AgentEvent } from "@repo/agent-driver/events";
import * as store from "@/main/store/store";
import { publishActivity } from "@/main/activity";
import { agentDriver } from "@/main/agents/agent-driver";
import type { RunResult } from "@/main/agents/agent-driver";
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
} from "@/main/prompts/briefs";
import type { TaskBrief } from "@/main/prompts/briefs";
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

const empName = (id: string): string => store.getEmployee(id)?.name ?? "someone";

const say = (companyId: string, line: string, to: string | null): void => {
  store.postTeamMessage(companyId, null, line);
  publishActivity({ kind: "chat", message: line.slice(0, 400), payload: { to } });
};

const ship = (
  task: Task,
  at: { runId: string; taskId: string; employeeId: string },
  summary: string,
): void => {
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
};

const onAgentEvent = (runId: string, task: Task, emp: Employee, ev: AgentEvent): void => {
  const at = { employeeId: emp.id, runId, taskId: task.id };
  switch (ev.type) {
    case "tool_start": {
      publishActivity({
        ...at,
        kind: "tool_call",
        message: ev.toolName,
        payload: { args: ev.args, kind: ev.kind },
      });
      break;
    }
    case "message_end": {
      if (ev.text) {
        publishActivity({ ...at, kind: "message", message: ev.text.slice(0, 2000) });
      }
      break;
    }
    default: {
      break;
    }
  }
};

/** Pause autopilot at the cap; running turns finish and report their cost. */
export const haltForBudget = (company: Company, spentUsd = company.spentUsd): void => {
  if (!company.autopilot) {
    return;
  }
  store.setAutopilot(company.id, false);
  publishActivity({
    kind: "budget.exhausted",
    payload: { budget: company.budget, spentUsd },
  });
};

/** Gather what the heartbeat brief is grounded in; the prompt module phrases it. */
const heartbeatBrief = (
  company: Company,
  emp: Employee,
  employees: Employee[],
  focus: Product | null,
): TaskBrief =>
  autonomousBrief({
    company,
    employee: emp,
    employees,
    focus,
    nameOf: empName,
    problems: store
      .listOpenTasks(company.id)
      .filter((t) => t.state.kind === "dead")
      .slice(0, 5),
    products: store.listProducts(company.id),
    room: store.recentTeamMessages(company.id, 12),
    ships: store.recentActivity(company.id, "ship", 6).map((s) => s.message),
  });

const admit = (company: Company): boolean => {
  if (!isOutOfBudget(company)) {
    return true;
  }
  haltForBudget(company);
  return false;
};

/** Usage limits park the runner without consuming a task retry. */
const finish = (runId: string, task: Task, emp: Employee, r: RunResult): void => {
  const at = { employeeId: emp.id, runId, taskId: task.id };
  const o = r.outcome;
  let status: TaskStatus;
  switch (o.kind) {
    case "blocked": {
      status = "blocked";
      store.settleTask(task.id, runId, {
        ask: o.ask,
        kind: "blocked",
        summary: r.summary || null,
      });
      break;
    }
    case "done": {
      status = "done";
      store.settleTask(task.id, runId, { kind: "done", summary: r.summary || null });
      ship(task, at, r.summary);
      break;
    }
    case "resting": {
      status = "queued";
      store.parkTask(task.id, runId, o.until, o.error);
      publishActivity({
        ...at,
        kind: "runner.resting",
        payload: { runner: emp.runner, until: o.until },
      });
      break;
    }
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
              error: o.error,
              maxAttempts: MAX_TASK_ATTEMPTS,
              retryAt: verdict.retryAt,
            },
          });
        }
      }
      break;
    }
    // no default
  }

  store.setEmployeeStatus(emp.id, "idle");
  store.noteRunEnd(emp.id, r.session);

  if (r.usage.costUsd > 0) {
    const before = store.getCompany(task.companyId);
    const after = store.recordSpend(task.companyId, r.usage.costUsd);
    if (before && after && !isOutOfBudget(before) && isOutOfBudget(after)) {
      haltForBudget(after);
    }
  }

  publishActivity({ ...at, kind: "status", message: status });
  publishActivity({
    ...at,
    kind: "run.end",
    payload: { costUsd: r.usage.costUsd, outcome: o, summary: r.summary },
  });
};

class Scheduler {
  private active = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  start(): void {
    if (this.timer) {
      return;
    }
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
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = null;
  }

  private fireDueRoutines(company: Company, employees: Employee[]): void {
    const now = Date.now();
    for (const r of store.listRoutines(company.id)) {
      if (this.active.size >= BACKGROUND_CAPACITY) {
        break;
      }
      if (r.lastRunAt !== null && now - r.lastRunAt < r.intervalHours * 3_600_000) {
        continue;
      }
      const idle = employees.filter((e) => e.status === "idle");
      const assignee =
        (r.role !== null &&
          idle.find((e) => `${e.role} ${e.title}`.toLowerCase().includes(r.role ?? ""))) ||
        idle[0];
      if (!assignee) {
        continue;
      }
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
      assigneeId: emp.id,
      priority,
    });
    this.tryAssign(task.id, emp.id);
    return task;
  }

  private tickAutopilot(): void {
    if (this.stopped) {
      return;
    }
    const company = store.getDefaultCompany();
    if (!company || !company.autopilot || !admit(company)) {
      return;
    }
    const employees = store.listEmployees(company.id);
    this.fireDueRoutines(company, employees);
    for (const emp of employees) {
      if (this.active.size >= BACKGROUND_CAPACITY) {
        break;
      }
      if (emp.status !== "idle") {
        continue;
      }
      if (agentDriver.restingRunner(emp.runner) !== null) {
        continue;
      }
      const open = store
        .openTasksFor(emp.id)
        .some((t) => t.state.kind === "queued" || t.state.kind === "running");
      if (open) {
        continue;
      }
      const focus = store.attentionProduct(company.id);
      this.brief(company, emp, heartbeatBrief(company, emp, employees, focus), focus?.id ?? null);
    }
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
      createProduct: (name: string, description: string): string => {
        if (!isLeader) {
          return "Only the team lead can start a product — raise it in the team room.";
        }
        const product = store.createProduct({ companyId: company.id, description, name });
        publishActivity({
          employeeId: emp.id,
          kind: "product.created",
          message: product.name,
          payload: { productId: product.id },
        });
        post(`🆕 New product: ${product.name} — ${product.description}`);
        return `Created "${product.name}" (${product.id}); its workspace is ${product.workspaceDir}. Delegate work to it with "product":"${product.id}".`;
      },
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
          assigneeId: mate.id,
          companyId: company.id,
          description,
          priority: "medium",
          productId,
          title,
        });
        post(`→ ${mate.name} (${mate.title}): ${title}`, mate.id);
        this.tryAssign(t.id, mate.id);
        return `Delegated "${title}" to ${mate.name} (${mate.title}). They'll report back in the team room.`;
      },
      hire: ({ role, title, name, persona }): string => {
        if (!isLeader) {
          return "Only the team lead can hire — raise it in the team room.";
        }
        const all = store.listEmployees(company.id);
        const hireName = name ?? `${title} ${all.length + 1}`;
        let hired: Employee;
        try {
          hired = store.createEmployee({
            companyId: company.id,
            deskIndex: all.length,
            name: hireName,
            persona: persona ?? `A focused, pragmatic ${title} who ships.`,
            role,
            runner: agentDriver.pickRunner(all.length),
            spriteSeed: spriteSeedFor(role, hireName),
            title,
          });
        } catch (error) {
          return `Couldn't hire: ${errorMessage(error)}. Release someone first or work with the team you have.`;
        }
        post(`🤝 hired ${hired.name} (${title})`);
        publishActivity({
          employeeId: hired.id,
          kind: "org.hired",
          payload: { by: emp.id, name: hired.name, title },
        });
        return `Hired ${hired.name} (${title}) — slug "${hired.id}". They start picking up work autonomously; delegate to them right away if you have something specific.`;
      },
      messageTeam: (text: string): void => post(text.slice(0, 400)),
      // The task only turns `blocked` when the run settles, but the ask exists
      // now — so the office raises the "!" over the employee's head at once.
      raiseAsk: (ask): void => {
        publishActivity({
          employeeId: emp.id,
          kind: "run.ask",
          payload: { ask },
          runId: run.runId,
          taskId: run.taskId,
        });
      },
      readTeam: (): string => roomTranscript(store.recentTeamMessages(company.id, 15), empName),
      release: (slug, reason): string => {
        if (!isLeader) {
          return "Only the team lead can release teammates.";
        }
        if (slug === emp.id) {
          return "You can't release yourself.";
        }
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
    };
  }

  /** Whole-token @slug or @first-name mentions wake the addressed employees. */
  founderMessage(companyId: string, text: string): void {
    say(companyId, text, null);
    for (const employeeId of resolveMentions(text, store.listEmployees(companyId))) {
      this.wakeEmployee(employeeId, founderPing(text));
    }
  }

  /** Direct requests wake the employee without relying on mention parsing. */
  directEmployee(employeeId: string, instruction: string): void {
    const emp = store.getEmployee(employeeId);
    if (!emp) {
      throw new Error(`no employee ${employeeId}`);
    }
    say(emp.companyId, `@${emp.id} ${instruction}`, emp.id);
    this.wakeEmployee(employeeId, founderPing(instruction));
  }

  private resumeBlocked(taskId: string, answer: string, whenNotBlocked: string): Task {
    const continuation = store.resolveBlockedWithAnswer(taskId, answer);
    if (!continuation || !continuation.assigneeId) {
      throw new Error(whenNotBlocked);
    }
    return this.assign(continuation.id, continuation.assigneeId);
  }

  answerQuestion(taskId: string, answer: string): Task {
    return this.resumeBlocked(taskId, answer, "task is not awaiting an answer");
  }

  resolveApproval(taskId: string, approved: boolean): Task {
    const task = store.getTask(taskId);
    if (!task || task.state.kind !== "blocked" || task.state.ask.type !== "approval") {
      throw new Error("task is not awaiting an approval");
    }
    // Record before resuming: the agent's retry hits the hook again, and it
    // must find the sign-off already there.
    if (approved) {
      store.grantApproval(task.companyId, task.state.ask.command);
    }
    return this.resumeBlocked(taskId, approvalAnswer(approved), "could not resume the task");
  }

  resumeIntegrationAsks(kind: IntegrationKind): void {
    const company = store.getDefaultCompany();
    if (!company) {
      return;
    }
    for (const task of store.listOpenTasks(company.id)) {
      const st = task.state;
      if (st.kind !== "blocked" || st.ask.type !== "integration") {
        continue;
      }
      if (st.ask.integration !== kind) {
        continue;
      }
      const continuation = store.resolveBlockedWithAnswer(
        task.id,
        integrationConnectedAnswer(kind),
      );
      if (continuation?.assigneeId) {
        this.tryAssign(continuation.id, continuation.assigneeId);
      }
    }
  }

  /** Coalesce identical requests still waiting for the same employee. */
  wakeEmployee(employeeId: string, brief: TaskBrief): Task | null {
    const emp = store.getEmployee(employeeId);
    if (!emp) {
      return null;
    }
    const company = store.getCompany(emp.companyId);
    if (!company || !admit(company)) {
      return null;
    }
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
    if (!claimed) {
      throw new Error("task is not assignable");
    }
    publishActivity({ employeeId, kind: "status", message: "queued", taskId });
    this.tick();
    return store.getTask(taskId) ?? claimed;
  }

  tick(): void {
    if (this.stopped) {
      return;
    }
    // Visit each candidate once: a rejected start must not spin on the same task.
    for (const task of store.listQueuedTasks()) {
      if (this.active.size >= GLOBAL_CONCURRENCY_CAP) {
        break;
      }
      if (this.active.size >= BACKGROUND_CAPACITY && task.priority !== "high") {
        continue;
      }
      if (task.assigneeId === null || isWorking(task.assigneeId)) {
        continue;
      }
      const employee = store.getEmployee(task.assigneeId);
      if (!employee || agentDriver.restingRunner(employee.runner) !== null) {
        continue;
      }
      this.startRun(task);
    }
  }

  private startRun(task: Task): void {
    if (this.stopped) {
      return;
    }
    const employeeId = task.assigneeId;
    if (!employeeId) {
      return;
    }
    const employee = store.getEmployee(employeeId);
    const company = store.getCompany(task.companyId);
    if (!employee || !company) {
      return;
    }
    // Check again at the spawn boundary: queued work may predate the budget cap.
    if (!admit(company)) {
      return;
    }

    const runId = crypto.randomUUID();
    const locked = store.lockTaskForRun(task.id, runId);
    // lost race
    if (!locked) {
      return;
    }

    store.setEmployeeStatus(employeeId, "working");
    this.active.add(runId);
    const at = { employeeId, runId, taskId: task.id };
    publishActivity({ ...at, kind: "run.start" });
    publishActivity({ ...at, kind: "status", message: "running" });

    void this.run(runId, task, employee, company);
  }

  private async run(
    runId: string,
    task: Task,
    employee: Employee,
    company: Company,
  ): Promise<void> {
    try {
      await this.execute(runId, task, employee, company);
    } catch (error) {
      finish(runId, task, employee, {
        outcome: { error: errorMessage(error), kind: "failed" },
        session: employee.sessionId,
        summary: "",
        usage: zeroUsage(),
      });
    } finally {
      this.active.delete(runId);
      this.tick();
    }
  }

  private async execute(runId: string, task: Task, emp: Employee, company: Company): Promise<void> {
    const product = task.productId === null ? null : store.getProduct(task.productId);
    const result = await agentDriver.runTask(
      emp,
      company,
      {
        description: `${runPreamble(product, company)}\n\n${task.description ?? ""}`.trim(),
        title: task.title,
        workspace: product?.workspaceDir ?? company.workspaceDir,
      },
      (ev: AgentEvent) => onAgentEvent(runId, task, emp, ev),
      this.hooksFor(emp, company, { productId: task.productId, runId, taskId: task.id }),
    );
    finish(runId, task, emp, result);
  }
}

export const scheduler = new Scheduler();
