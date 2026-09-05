import { zeroUsage, type AgentEvent, type AgentUsage } from "@repo/agent-driver/events";
import * as store from "@/main/store/store";
import { publishActivity } from "@/main/activity";
import { agentDriver, priceRun, type RunResult } from "@/main/agents/agent-driver";
import type { RunToolHooks } from "@/main/control-plane";
import { errorMessage } from "@/shared/errors";
import {
  approvalAnswer,
  autonomousBrief,
  founderPing,
  integrationConnectedAnswer,
  roomTranscript,
  routineBrief,
  type TaskBrief,
} from "@/main/prompts/briefs";
import { MAX_TASK_ATTEMPTS, isOutOfBudget, resolveMentions, spriteSeedFor } from "@/shared/domain";
import type {
  Company,
  Employee,
  IntegrationKind,
  Task,
  TaskPriority,
  TaskStatus,
} from "@/shared/domain";

const GLOBAL_CONCURRENCY_CAP = 3;

/**
 * Slots the office's own background work may never occupy.
 *
 * Autopilot refills every free slot each tick with multi-minute runs, and
 * nothing preempts a run in flight — so without a reserved lane, speaking to
 * an employee meant waiting for one of them to finish. Measured at six-plus
 * minutes between saying something and the employee starting on it, which is
 * the wrong feel for a game whose whole premise is that you are the founder
 * talking to your staff.
 *
 * Priority ordering alone did not fix this: founder-initiated work is already
 * queued `high`, but priority only orders what is *waiting*, and the slots
 * were already gone.
 *
 * The cost is a third of background throughput while the lane sits idle. For
 * an idle game that is invisible; being ignored for six minutes is not.
 */
const FOUNDER_RESERVED_SLOTS = 1;
/** How many slots the office's own work may fill; the rest is the founder's. */
const BACKGROUND_CAPACITY = GLOBAL_CONCURRENCY_CAP - FOUNDER_RESERVED_SLOTS;

const AUTOPILOT_TICK_MS = 10_000;

/** A run is in flight for them. The scheduler owns this fact; the store only holds it. */
const isWorking = (employeeId: string): boolean =>
  store.getEmployee(employeeId)?.status === "working";

/**
 * Async run scheduler. Respects a global concurrency cap and a per-employee
 * single-active lock (the employee's in-memory status, plus the task's runId
 * lock persisted in its TASK.md). Streams agent events to the activity log.
 */
class Scheduler {
  private active = new Map<string, string>(); // runId -> employeeId
  /**
   * runId -> USD spent by that run so far, priced from streamed token deltas.
   * An estimate on purpose: the authoritative figure arrives with the result
   * and is what gets written to spentUsd. This exists only so the cap can be
   * enforced while runs are still going.
   */
  private liveSpend = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Begin the idle-game loop: idle employees self-direct work while autopilot is on. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.onTick(), AUTOPILOT_TICK_MS);
    this.onTick();
  }

  /**
   * One scheduler beat. Always drain the queue first so backoff retries resume
   * even with autopilot off; then self-direct idle employees if autopilot is on.
   */
  private onTick(): void {
    this.tick();
    this.tickAutopilot();
  }

  /** Stop the loop (reset teardown). In-flight runs settle on their own. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * May this company buy work right now? One predicate for the four places
   * that ask — queueing paths use it to avoid writing task rows for work that
   * will never run, and startRun uses it because it is the only place a paid
   * CLI is actually spawned. Finding the budget gone halts the office.
   */
  private admit(company: Company): boolean {
    if (!isOutOfBudget(company)) return true;
    this.haltForBudget(company);
    return false;
  }

  /**
   * The budget is spent: pause autopilot and tell the founder why. Idempotent,
   * so every path that discovers the cap can call it — a run's final bill, a
   * live estimate crossing the line, the founder lowering the cap.
   */
  haltForBudget(company: Company, spentUsd = company.spentUsd): void {
    if (!company.autopilot) return;
    store.setAutopilot(company.id, false);
    publishActivity({
      kind: "budget.exhausted",
      payload: { spentUsd, budget: company.budget },
    });
  }

  /** Fire any routine whose cadence is due, assigned to a matching idle employee. */
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
      this.brief(company, assignee, routineBrief(r));
    }
  }

  /** Give an employee work now: create the task and try to start it. */
  private brief(
    company: Company,
    emp: Employee,
    brief: TaskBrief,
    priority: TaskPriority = "medium",
  ): Task {
    const task = store.createTask({
      companyId: company.id,
      ...brief,
      priority,
      assigneeId: emp.id,
    });
    this.tryAssign(task.id, emp.id);
    return task;
  }

  /** Top up idle employees with self-directed work (respecting the concurrency cap). */
  private tickAutopilot(): void {
    const company = store.getDefaultCompany();
    if (!company || !company.autopilot || !this.admit(company)) return;
    const employees = store.listEmployees(company.id);
    this.fireDueRoutines(company, employees);
    for (const emp of employees) {
      if (this.active.size >= BACKGROUND_CAPACITY) break;
      if (emp.status !== "idle") continue;
      // don't brief employees whose CLI is resting on a usage limit
      if (agentDriver.restingRunner(emp.runner) !== null) continue;
      const open = store
        .openTasksFor(emp.id)
        .some((t) => t.state.kind === "queued" || t.state.kind === "running");
      if (open) continue;
      this.brief(company, emp, this.autonomousBrief(company, emp, employees));
    }
  }

  /** Gather what the heartbeat brief is grounded in; the prompt module phrases it. */
  private autonomousBrief(company: Company, emp: Employee, employees: Employee[]): TaskBrief {
    return autonomousBrief({
      company,
      employee: emp,
      employees,
      room: store.recentTeamMessages(company.id, 12),
      ships: store.recentActivity(company.id, "ship", 6).map((s) => s.message),
      problems: store
        .listOpenTasks(company.id)
        .filter((t) => t.state.kind === "dead")
        .slice(0, 5),
      nameOf: (id) => this.empName(id),
    });
  }

  /** Resolve an employee id to a display name for briefs/feeds. */
  private empName(id: string): string {
    return store.getEmployee(id)?.name ?? "someone";
  }

  /** Tools the running agent can call to operate the business with teammates. */
  private hooksFor(
    emp: Employee,
    company: Company,
    run: { runId: string; taskId: string },
  ): RunToolHooks {
    const isLeader = company.leaderId === emp.id;

    /** Mirror a line into the company room and the activity feed. */
    const post = (text: string, to: string | null = null): void => {
      store.postTeamMessage(company.id, emp.id, text);
      publishActivity({ employeeId: emp.id, kind: "chat", message: text, payload: { to } });
    };

    return {
      messageTeam: (text: string): void => post(text.slice(0, 400)),
      readTeam: (): string =>
        roomTranscript(store.recentTeamMessages(company.id, 15), (id) => this.empName(id)),
      delegate: (role: string, title: string, description: string): string => {
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
          title,
          description,
          priority: "medium",
          assigneeId: mate.id,
        });
        post(`→ ${mate.name} (${mate.title}): ${title}`, mate.id);
        this.tryAssign(t.id, mate.id);
        return `Delegated "${title}" to ${mate.name} (${mate.title}). They'll report back in the team room.`;
      },
      hire: ({ role, title, name, persona }): string => {
        if (!isLeader) return "Only the team lead can hire — raise it in the team room.";
        const all = store.listEmployees(company.id);
        const hireName = name ?? `${title} ${all.length + 1}`;
        let hired: Employee;
        try {
          // the seat cap is enforced by the store — every hire path hits it
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
        publishActivity({ ...run, employeeId: emp.id, kind: "run.ask", payload: { ask } });
      },
    };
  }

  /**
   * Founder speaks in the team room. The message lands in the channel and the
   * room log; `@slug` or `@first-name` mentions (whole-token, see
   * resolveMentions) wake those employees immediately with the message as
   * context (paperclip's mention-wake convention).
   */
  founderMessage(companyId: string, text: string): void {
    store.postTeamMessage(companyId, null, text);
    publishActivity({ kind: "chat", message: text.slice(0, 400), payload: { to: null } });
    for (const employeeId of resolveMentions(text, store.listEmployees(companyId))) {
      this.wakeEmployee(employeeId, founderPing(text));
    }
  }

  /**
   * The founder speaks to one employee. The room still records it (addressed,
   * so teammates see who was asked) and the employee wakes on the instruction
   * itself — not on whether the room's mention grammar recognised them.
   */
  directEmployee(employeeId: string, instruction: string): void {
    const emp = store.getEmployee(employeeId);
    if (!emp) throw new Error(`no employee ${employeeId}`);
    const line = `@${emp.id} ${instruction}`;
    store.postTeamMessage(emp.companyId, null, line);
    publishActivity({ kind: "chat", message: line.slice(0, 400), payload: { to: emp.id } });
    this.wakeEmployee(employeeId, founderPing(instruction));
  }

  /** A completed task ships work: the count behind the product plate, the feed, and every tenth one a cheer. */
  private ship(
    companyId: string,
    at: { runId: string; taskId: string; employeeId: string },
    summary: string,
  ): void {
    store.recordShip(companyId);
    publishActivity({ ...at, kind: "ship", message: (summary || "shipped work").slice(0, 200) });
    const ships = store.getCompany(companyId)?.ships ?? 0;
    if (ships > 0 && ships % 10 === 0) {
      store.postTeamMessage(companyId, null, `🎉 Milestone: ${ships} things shipped — keep going!`);
    }
  }

  /** Every blocked-ask type resumes the same way: answer it, then run the continuation. */
  private resumeBlocked(taskId: string, answer: string, whenNotBlocked: string): Task {
    const continuation = store.resolveBlockedWithAnswer(taskId, answer);
    if (!continuation || !continuation.assigneeId) throw new Error(whenNotBlocked);
    return this.assign(continuation.id, continuation.assigneeId);
  }

  /** The founder answers a question the agent stopped on. */
  answerQuestion(taskId: string, answer: string): Task {
    return this.resumeBlocked(taskId, answer, "task is not awaiting an answer");
  }

  /** The founder signs off (or refuses) a command the policy held. */
  resolveApproval(taskId: string, approved: boolean): Task {
    const task = store.getTask(taskId);
    if (!task || task.state.kind !== "blocked" || task.state.ask.type !== "approval")
      throw new Error("task is not awaiting an approval");
    // Record before resuming: the agent's retry hits the hook again, and it
    // must find the sign-off already there.
    if (approved) store.grantApproval(task.companyId, task.state.ask.command);
    return this.resumeBlocked(taskId, approvalAnswer(approved), "could not resume the task");
  }

  /**
   * The founder connected an integration: every task blocked on a typed ask
   * for it resumes automatically (paperclip's wake-assignee convention).
   */
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

  /**
   * Event wake (paperclip convention): create + assign a task for an employee
   * right now instead of waiting for the autopilot tick. Coalesces — the same
   * wake, still waiting for the same employee, is not duplicated.
   */
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
    return waiting ?? this.brief(company, emp, brief, "high");
  }

  /** Assign, tolerating a busy assignee — the queue picks it up next tick. */
  private tryAssign(taskId: string, employeeId: string): void {
    try {
      this.assign(taskId, employeeId);
    } catch {
      /* claim race or busy — retried on a later tick */
    }
  }

  /** Player assigns a task to an employee, then we try to run it. */
  assign(taskId: string, employeeId: string): Task {
    const task = store.getTask(taskId);
    const company = task ? store.getCompany(task.companyId) : null;
    if (company && !this.admit(company)) {
      throw new Error("Out of budget — raise the budget in the HUD to assign work.");
    }
    const claimed = store.claimTask(taskId, employeeId);
    if (!claimed) throw new Error("task is not assignable");
    publishActivity({ taskId, employeeId, kind: "status", message: "queued" });
    this.tick();
    return store.getTask(taskId) ?? claimed;
  }

  /** Pull queued tasks into runs while we have capacity. */
  tick(): void {
    while (this.active.size < GLOBAL_CONCURRENCY_CAP) {
      // Past the background capacity only founder-initiated work starts —
      // talking to an employee, or resuming what you just answered.
      const backgroundOk = this.active.size < BACKGROUND_CAPACITY;
      const next = store.listQueuedTasks().find((t) => {
        if (!backgroundOk && t.priority !== "high") return false;
        if (t.assigneeId === null || isWorking(t.assigneeId)) return false;
        const runner = store.getEmployee(t.assigneeId)?.runner;
        return runner === undefined || agentDriver.restingRunner(runner) === null;
      });
      if (!next) break;
      this.startRun(next);
    }
  }

  private startRun(task: Task): void {
    const employeeId = task.assigneeId;
    if (!employeeId) return;
    const employee = store.getEmployee(employeeId);
    const company = store.getCompany(task.companyId);
    if (!employee || !company) return;
    // The choke point: the only place a paid CLI is spawned. The queueing
    // paths check too, but tick() drains straight through here, so work queued
    // before the cap blew would otherwise keep spending after it.
    if (!this.admit(company)) return;

    const runId = crypto.randomUUID();
    const locked = store.lockTaskForRun(task.id, runId);
    if (!locked) return; // lost race

    store.setEmployeeStatus(employeeId, "working");
    this.active.set(runId, employeeId);
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
        // drop the estimate: finish() has recorded what this run really cost
        this.liveSpend.delete(runId);
        this.tick();
      });
  }

  private async execute(runId: string, task: Task, emp: Employee, company: Company): Promise<void> {
    const result = await agentDriver.runTask(
      emp,
      company,
      { title: task.title, description: task.description },
      (ev: AgentEvent) => this.onAgentEvent(runId, task, emp, ev),
      this.hooksFor(emp, company, { runId, taskId: task.id }),
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
      case "usage":
        this.trackLiveSpend(runId, emp, ev.usage);
        break;
      default:
        break;
    }
  }

  /**
   * Stop the office the moment the cap is actually reached, rather than at the
   * next run boundary. A single run can cost several dollars, so "check before
   * starting" let a $5 cap spend $12.
   *
   * Claude reports usage per assistant turn, so its runs are cut off mid-flight.
   * Codex only reports when a turn completes, so its own run always finishes —
   * but crossing the line still stops everything else in the office.
   */
  private trackLiveSpend(runId: string, emp: Employee, usage: AgentUsage): void {
    const company = store.getCompany(emp.companyId);
    if (!company || company.budget.mode !== "capped") return;
    this.liveSpend.set(runId, (this.liveSpend.get(runId) ?? 0) + priceRun(emp, usage));
    const inFlight = [...this.liveSpend.values()].reduce((a, b) => a + b, 0);
    if (company.spentUsd + inFlight < company.budget.capUsd) return;

    this.haltForBudget(company, company.spentUsd + inFlight);
    for (const employeeId of this.active.values()) agentDriver.disposeEmployee(employeeId);
  }

  /**
   * Settle the task the way the run ended. A failed run is retried with
   * exponential backoff up to MAX_TASK_ATTEMPTS, then dead-lettered rather than
   * silently abandoned; a usage limit parks it until the reset without burning
   * an attempt, because that wall is the CLI's, not the task's.
   */
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
        this.ship(task.companyId, at, r.summary);
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

    // real AI spend drains the founder's budget (the driver reports what a run
    // cost even when it was killed, so this is truthful either way)
    if (r.usage.costUsd > 0) {
      const before = store.getCompany(task.companyId);
      const after = store.recordSpend(task.companyId, r.usage.costUsd);
      if (before && after && !isOutOfBudget(before) && isOutOfBudget(after)) {
        this.haltForBudget(after);
      }
    }

    publishActivity({ ...at, kind: "status", message: status });
    publishActivity({ ...at, kind: "run.end", payload: { summary: r.summary, outcome: o } });
  }
}

export const scheduler = new Scheduler();
