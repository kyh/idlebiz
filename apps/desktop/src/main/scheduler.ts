import { zeroUsage, type AgentEvent, type AgentUsage } from "@repo/agent-driver/events";
import * as store from "@/main/store/store";
import { publishActivity } from "@/main/activity";
import { agentDriver, priceRun, type RunResult } from "@/main/agents/agent-driver";
import type { RunToolHooks } from "@/main/control-plane";
import { errorMessage } from "@/shared/errors";
import {
  INTEGRATION_LABELS,
  MAX_TASK_ATTEMPTS,
  businessTypeById,
  isOutOfBudget,
  resolveMentions,
  retryDelayMs,
} from "@/shared/domain";
import type { Company, Employee, IntegrationKind, Task, TaskStatus } from "@/shared/domain";

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

/** What a self-directed heartbeat asks an employee to do next. */
interface TaskBrief {
  title: string;
  description: string;
}

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
    // an un-onboarded company is mid-hire or abandoned: it has employees on
    // disk but its founder never saw the budget step, so briefing them here
    // spends money nobody agreed to
    if (!company.onboarded) return false;
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
      if (this.active.size >= this.backgroundCapacity()) break;
      if (r.lastRunAt !== null && now - r.lastRunAt < r.intervalHours * 3_600_000) continue;
      const idle = employees.filter((e) => e.status === "idle");
      const assignee =
        (r.role && idle.find((e) => `${e.role} ${e.title}`.toLowerCase().includes(r.role ?? ""))) ||
        idle[0];
      if (!assignee) continue;
      store.markRoutineRun(company.id, r.id);
      const task = store.createTask({
        companyId: company.id,
        title: r.name,
        description: `${r.instruction}\n\n(Recurring company routine — runs every ${r.intervalHours}h.)`,
        priority: "medium",
        assigneeId: assignee.id,
      });
      try {
        this.assign(task.id, assignee.id);
      } catch {
        /* picked up next tick */
      }
    }
  }

  /** Top up idle employees with self-directed work (respecting the concurrency cap). */
  private tickAutopilot(): void {
    const company = store.getDefaultCompany();
    if (!company || !company.autopilot || !this.admit(company)) return;
    const employees = store.listEmployees(company.id);
    this.fireDueRoutines(company, employees);
    for (const emp of employees) {
      if (this.active.size >= this.backgroundCapacity()) break;
      if (emp.status !== "idle") continue;
      // don't brief employees whose CLI is resting on a usage limit
      if (agentDriver.restingRunner(emp.runner) !== null) continue;
      const open = store
        .listTasksForEmployee(emp.id)
        .some((t) => t.status === "queued" || t.status === "running");
      if (open) continue;
      const brief = this.autonomousBrief(company, emp, employees);
      const task = store.createTask({
        companyId: company.id,
        title: brief.title,
        description: brief.description,
        priority: "medium",
        assigneeId: emp.id,
      });
      try {
        this.assign(task.id, emp.id);
      } catch {
        /* claim race — picked up next tick */
      }
    }
  }

  /**
   * The per-employee heartbeat: prompt for their next autonomous move, grounded
   * in the team room, recent ships, and recent failures. The team leader is asked
   * to coordinate (chain / fan out) while members execute and report back.
   */
  private autonomousBrief(company: Company, emp: Employee, employees: Employee[]): TaskBrief {
    const team = store.teamForEmployee(emp.id);
    const isLeader = team?.leaderId === emp.id;
    const teammates = team ? employees.filter((e) => e.teamId === team.id) : employees;
    const roster =
      teammates
        .map((e) => `${e.name} (${e.title})${team?.leaderId === e.id ? " — lead" : ""}`)
        .join(", ") || "(just you)";

    const room =
      (team
        ? store
            .recentTeamMessages(team.id, 12)
            .map(
              (m) =>
                `- ${m.fromEmployeeId ? this.empName(m.fromEmployeeId) : "founder"}: ${m.text}`,
            )
            .join("\n")
        : "") || "(no messages yet)";
    const ships =
      store
        .recentActivity(company.id, "ship", 6)
        .map((s) => `- ${s.message}`)
        .join("\n") || "(nothing shipped yet)";
    const problems =
      store
        .listTasks(company.id)
        .filter((t) => t.status === "dead")
        .slice(0, 5)
        .map((t) => `- ${t.title}${t.lastError ? ` (last error: ${t.lastError})` : ""}`)
        .join("\n") || "(none)";

    const budgetLine =
      company.budget.mode === "capped"
        ? `AI budget: $${company.spentUsd.toFixed(2)} of $${company.budget.capUsd.toFixed(2)} spent${company.spentUsd >= company.budget.capUsd * 0.8 ? " — over 80%: critical work only, keep runs short" : ""}.`
        : `AI spend so far: $${company.spentUsd.toFixed(2)} (no cap set).`;

    const coordinate = isLeader
      ? `You LEAD ${team?.name ?? "this team"}. Your job is to coordinate: decide the most valuable next outcome, then either do one focused chunk yourself or break it up and hand pieces to teammates — use the delegate tool once for a single handoff, or several times to fan work out in parallel. Keep everyone moving and unblocked.
You also OWN headcount (hard cap ${company.maxAgents} seats, ${employees.length} filled): hire when the backlog demands a role you don't have (hire tool — give role, title, name, persona), release teammates whose role stopped pulling weight (release tool — their work is archived, not lost). Size the team to the budget: more people burn money faster. ${budgetLine}`
      : `You're on ${team?.name ?? "the team"}${team?.leaderId ? `, led by ${this.empName(team.leaderId)}` : ""}. Check the team room first with read_team_chat, pick up what your role should own, and execute it. If something is better owned by another role, hand it off with the delegate tool. ${budgetLine}`;

    const description = [
      `You are operating autonomously to grow ${company.name}.`,
      `Mission: ${company.mission}`,
      `Business type: ${businessTypeById(company.businessType).label}.`,
      `Your role: ${emp.title}.`,
      `Your team: ${roster}.`,
      ``,
      `Recent team room:`,
      room,
      ``,
      `Recently shipped:`,
      ships,
      ``,
      `Recent failures to consider fixing or unblocking:`,
      problems,
      ``,
      coordinate,
      `Make it real: products should end up runnable, and when ready, published (ask the founder via ask_boss before anything outward-facing like deploying or posting).`,
      `When you finish, post a one-line update to the team room with message_team(text).`,
      `End with a short summary of exactly what you shipped and where it lives (files, URLs).`,
    ].join("\n");
    return { title: `Advance ${company.name}`, description };
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
    const team = store.teamForEmployee(emp.id);
    const isLeader = team?.leaderId === emp.id;

    /** Mirror a line into the team room (if any) and the company activity feed. */
    const post = (text: string, to: string | null = null): void => {
      if (team) store.postTeamMessage(team.id, emp.id, text);
      publishActivity({ employeeId: emp.id, kind: "chat", message: text, payload: { to } });
    };

    return {
      messageTeam: (text: string): void => post(text.slice(0, 400)),
      readTeam: (): string => {
        if (!team) return "";
        return store
          .recentTeamMessages(team.id, 15)
          .map(
            (m) => `- ${m.fromEmployeeId ? this.empName(m.fromEmployeeId) : "founder"}: ${m.text}`,
          )
          .join("\n");
      },
      delegate: (role: string, title: string, description: string): string => {
        const want = role.toLowerCase();
        const pool = store.listEmployees(company.id).filter((e) => e.id !== emp.id);
        const matches = (e: Employee): boolean =>
          e.role.toLowerCase() === want || e.title.toLowerCase().includes(want);
        // prefer a teammate on the same team, then anyone in the company
        const sameTeam = team ? pool.filter((e) => e.teamId === team.id) : [];
        const mate = sameTeam.find(matches) ?? pool.find(matches);
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
            spriteSeed: `${role}-${hireName}-${Date.now().toString(36)}`,
            deskIndex: all.length,
          });
        } catch (err) {
          return `Couldn't hire: ${errorMessage(err)}. Release someone first or work with the team you have.`;
        }
        if (team) store.addTeamMember(team.id, hired.id);
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
  founderMessage(companyId: string, teamId: string, text: string): void {
    store.postTeamMessage(teamId, null, text);
    publishActivity({ kind: "chat", message: text.slice(0, 400), payload: { to: null } });
    for (const employeeId of resolveMentions(text, store.listEmployees(companyId))) {
      this.wakeEmployee(
        employeeId,
        `Founder: ${text.slice(0, 48)}`,
        [
          "The founder pinged you in the team room:",
          `"${text}"`,
          "",
          "Read the room with read_team_chat for context, do what they're asking (or answer their question), and reply with message_team.",
        ].join("\n"),
      );
    }
  }

  /**
   * The founder connected an integration: every task blocked on a typed ask
   * for it resumes automatically (paperclip's wake-assignee convention).
   */
  resumeIntegrationAsks(kind: IntegrationKind): void {
    const company = store.getDefaultCompany();
    if (!company) return;
    for (const task of store.listTasks(company.id)) {
      if (task.status !== "blocked" || task.blocked?.type !== "integration") continue;
      if (task.blocked.integration !== kind) continue;
      const continuation = store.resolveBlockedWithAnswer(
        task.id,
        `${INTEGRATION_LABELS[kind]} is now connected — the credentials are in your environment. Continue where you left off.`,
      );
      if (continuation?.assigneeId) this.tryAssign(continuation.id, continuation.assigneeId);
    }
  }

  /**
   * Event wake (paperclip convention): create + assign a task for an employee
   * right now instead of waiting for the autopilot tick. Coalesces — an
   * identical queued wake for the same employee is not duplicated.
   */
  wakeEmployee(employeeId: string, title: string, description: string): Task | null {
    const emp = store.getEmployee(employeeId);
    if (!emp) return null;
    const company = store.getCompany(emp.companyId);
    if (!company || !this.admit(company)) return null;
    const open = store
      .listTasksForEmployee(employeeId)
      .find((t) => t.title === title && (t.status === "queued" || t.status === "todo"));
    if (open) return open;
    const task = store.createTask({
      companyId: company.id,
      title,
      description,
      priority: "high",
      assigneeId: employeeId,
    });
    this.tryAssign(task.id, employeeId);
    return task;
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

  /** How many slots the office's own work may fill; the rest is yours. */
  private backgroundCapacity(): number {
    return GLOBAL_CONCURRENCY_CAP - FOUNDER_RESERVED_SLOTS;
  }

  /** Pull queued tasks into runs while we have capacity. */
  tick(): void {
    while (this.active.size < GLOBAL_CONCURRENCY_CAP) {
      // Past the background capacity only founder-initiated work starts —
      // talking to an employee, or resuming what you just answered.
      const backgroundOk = this.active.size < this.backgroundCapacity();
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
        store.releaseTask(task.id, runId, "blocked", r.summary || null, o.ask);
        break;
      case "done":
        status = "done";
        store.releaseTask(task.id, runId, "done", r.summary || null, null);
        // a completed task ships work — the real counter behind the product version
        store.recordShip(task.companyId);
        publishActivity({
          ...at,
          kind: "ship",
          message: (r.summary || "shipped work").slice(0, 200),
        });
        break;
      case "resting":
        status = "queued";
        store.requeueForRetry(task.id, runId, task.attempts, o.until, o.error);
        publishActivity({
          ...at,
          kind: "runner.resting",
          payload: { runner: emp.runner, until: o.until },
        });
        break;
      case "failed": {
        const attempts = task.attempts + 1;
        if (attempts >= MAX_TASK_ATTEMPTS) {
          status = "dead";
          store.deadLetterTask(task.id, runId, attempts, o.error);
          publishActivity({ ...at, kind: "task.dead", payload: { attempts, error: o.error } });
        } else {
          status = "queued";
          const retryAt = Date.now() + retryDelayMs(attempts);
          store.requeueForRetry(task.id, runId, attempts, retryAt, o.error);
          publishActivity({
            ...at,
            kind: "task.retry",
            payload: { attempts, maxAttempts: MAX_TASK_ATTEMPTS, retryAt, error: o.error },
          });
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
