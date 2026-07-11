import { EventEmitter } from "node:events";
import type { AgentEvent, AgentUsage } from "@repo/agent-driver/events";
import * as store from "@/main/store/store";
import { agentDriver } from "@/main/agents/agent-driver";
import type { RunToolHooks } from "@/main/control-plane";
import { pluginHost } from "@/main/plugins";
import type { RunContext, RunOutcome } from "@/main/plugins";
import { MAX_TASK_ATTEMPTS, businessTypeById, isOutOfBudget, retryDelayMs } from "@/shared/domain";
import type { ActivityEvent, Company, Employee, Task } from "@/shared/domain";

const GLOBAL_CONCURRENCY_CAP = 3;

/**
 * Async run scheduler. Respects a global concurrency cap and a per-employee
 * single-active lock (the busy Set in-process, plus the task's runId lock
 * persisted in its TASK.md). Streams agent events to the activity log + renderer.
 */
const AUTOPILOT_TICK_MS = 10_000;

class Scheduler {
  readonly events = new EventEmitter();
  private active = new Map<string, string>(); // runId -> employeeId
  private busy = new Set<string>(); // employeeId
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

  /** Out-of-budget halt: pause autopilot once and tell the founder why. */
  private haltForBudget(company: Company): void {
    if (!company.autopilot) return;
    store.setAutopilot(company.id, false);
    this.emit({
      kind: "lifecycle",
      message: "budget.exhausted",
      payload: { spentUsd: company.spentUsd, budget: company.budget },
    });
  }

  /** Fire any routine whose cadence is due, assigned to a matching idle employee. */
  private fireDueRoutines(company: Company, employees: Employee[]): void {
    const now = Date.now();
    for (const r of store.listRoutines(company.id)) {
      if (this.active.size >= GLOBAL_CONCURRENCY_CAP) break;
      if (r.lastRunAt !== null && now - r.lastRunAt < r.intervalHours * 3_600_000) continue;
      const idle = employees.filter((e) => e.status === "idle" && !this.busy.has(e.id));
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
    if (!company || !company.autopilot) return;
    if (isOutOfBudget(company)) {
      this.haltForBudget(company);
      return;
    }
    const employees = store.listEmployees(company.id);
    this.fireDueRoutines(company, employees);
    for (const emp of employees) {
      if (this.active.size >= GLOBAL_CONCURRENCY_CAP) break;
      if (emp.status !== "idle" || this.busy.has(emp.id)) continue;
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
  private autonomousBrief(
    company: Company,
    emp: Employee,
    employees: Employee[],
  ): { title: string; description: string } {
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
        .map((s) => `- ${s.message ?? ""}`)
        .join("\n") || "(nothing shipped yet)";
    const problems =
      store
        .listTasks(company.id)
        .filter((t) => t.status === "dead" || t.status === "failed")
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
  private hooksFor(emp: Employee, company: Company): RunToolHooks {
    const team = store.teamForEmployee(emp.id);
    const isLeader = team?.leaderId === emp.id;

    /** Mirror a line into the team room (if any) and the company activity feed. */
    const post = (text: string): void => {
      if (team) store.postTeamMessage(team.id, emp.id, text);
      this.emit({ employeeId: emp.id, kind: "chat", message: text });
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
        post(`→ ${mate.name} (${mate.title}): ${title}`);
        try {
          this.assign(t.id, mate.id);
        } catch {
          /* mate busy — runs on a later tick */
        }
        return `Delegated "${title}" to ${mate.name} (${mate.title}). They'll report back in the team room.`;
      },
      hire: ({ role, title, name, persona }): string => {
        if (!isLeader) return "Only the team lead can hire — raise it in the team room.";
        const all = store.listEmployees(company.id);
        if (all.length >= company.maxAgents) {
          return `The office is at its ${company.maxAgents}-seat cap — release someone first or work with the team you have.`;
        }
        const hireName = name ?? `${title} ${all.length + 1}`;
        const hired = store.createEmployee({
          companyId: company.id,
          name: hireName,
          role,
          title,
          persona: persona ?? `A focused, pragmatic ${title} who ships.`,
          runner: agentDriver.pickRunner(all.length),
          spriteSeed: `${role}-${hireName}-${Date.now().toString(36)}`,
          deskIndex: all.length,
        });
        if (team) store.addTeamMember(team.id, hired.id);
        post(`🤝 hired ${hired.name} (${title})`);
        this.emit({
          employeeId: hired.id,
          kind: "lifecycle",
          message: "org.hired",
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
        if (this.busy.has(slug)) {
          return `${target.name} is mid-task right now — try again when they're idle.`;
        }
        agentDriver.disposeEmployee(slug);
        store.archiveEmployee(slug);
        post(`👋 ${target.name} was released${reason ? ` — ${reason}` : ""}`);
        this.emit({
          employeeId: target.id,
          kind: "lifecycle",
          message: "org.released",
          payload: { by: emp.id, name: target.name, reason },
        });
        return `Released ${target.name}. Their workspace contributions and memory are archived under alumni/.`;
      },
    };
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
    if (!company || isOutOfBudget(company)) return null;
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
    try {
      this.assign(task.id, employeeId);
    } catch {
      /* busy — the queue picks it up next tick */
    }
    return task;
  }

  /** Player assigns a task to an employee, then we try to run it. */
  assign(taskId: string, employeeId: string): Task {
    const task = store.getTask(taskId);
    const company = task ? store.getCompany(task.companyId) : null;
    if (company && isOutOfBudget(company)) {
      throw new Error("Out of budget — raise the budget in the HUD to assign work.");
    }
    const claimed = store.claimTask(taskId, employeeId);
    if (!claimed) throw new Error("task is not assignable");
    this.emit({ taskId, employeeId, kind: "status", message: "queued" });
    this.tick();
    return store.getTask(taskId) ?? claimed;
  }

  /** Pull queued tasks into runs while we have capacity. */
  tick(): void {
    while (this.active.size < GLOBAL_CONCURRENCY_CAP) {
      const next = store
        .listQueuedTasks()
        .find((t) => t.assigneeId !== null && !this.busy.has(t.assigneeId));
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

    const runId = crypto.randomUUID();
    const locked = store.lockTaskForRun(task.id, runId);
    if (!locked) return; // lost race

    store.setEmployeeStatus(employeeId, "working");
    this.active.set(runId, employeeId);
    this.busy.add(employeeId);
    this.emit({ runId, taskId: task.id, employeeId, kind: "lifecycle", message: "run.start" });
    this.emit({ runId, taskId: task.id, employeeId, kind: "status", message: "running" });

    void this.execute(runId, task, employee, company)
      .catch((err: unknown) => {
        this.finish(runId, task, employee, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          summary: "",
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
        });
      })
      .finally(() => {
        this.active.delete(runId);
        this.busy.delete(employeeId);
        this.tick();
      });
  }

  private async execute(runId: string, task: Task, emp: Employee, company: Company): Promise<void> {
    // pre-run plugin hook: let plugins append extra instructions to the brief
    const ctx: RunContext = { company, employee: emp, task };
    const extra = pluginHost.collectRunStart(ctx);
    const description = extra ? `${task.description ?? ""}\n\n${extra}`.trim() : task.description;
    const result = await agentDriver.runTask(
      emp,
      company,
      { id: task.id, title: task.title, description },
      (ev: AgentEvent) => this.onAgentEvent(runId, task, emp, ev),
      this.hooksFor(emp, company),
    );
    this.finish(runId, task, emp, result);
  }

  private onAgentEvent(runId: string, task: Task, emp: Employee, ev: AgentEvent): void {
    switch (ev.type) {
      case "tool_start":
        this.emit({
          runId,
          taskId: task.id,
          employeeId: emp.id,
          kind: "tool_call",
          message: ev.toolName,
          payload: { args: ev.args },
        });
        break;
      case "message_end":
        if (ev.role === "assistant" && ev.text) {
          this.emit({
            runId,
            taskId: task.id,
            employeeId: emp.id,
            kind: "message",
            message: ev.text.slice(0, 2000),
          });
        }
        break;
      default:
        break;
    }
  }

  private finish(
    runId: string,
    task: Task,
    emp: Employee,
    r: {
      ok: boolean;
      error?: string;
      summary: string;
      usage: AgentUsage;
      sessionId?: string;
      blockedQuestion?: string;
      staleSession?: boolean;
    },
  ): void {
    // Decide the outcome. A failed run is retried with exponential backoff up to
    // MAX_TASK_ATTEMPTS, then dead-lettered rather than silently abandoned.
    let taskStatus: RunOutcome["status"];
    let retryAt: number | null = null;
    if (r.blockedQuestion) {
      taskStatus = "blocked";
      store.releaseTask(task.id, runId, "blocked", r.summary || null, r.blockedQuestion);
    } else if (r.ok) {
      taskStatus = "done";
      store.releaseTask(task.id, runId, "done", r.summary || null, null);
    } else {
      const attempts = task.attempts + 1;
      const err = r.error || "run failed";
      if (attempts >= MAX_TASK_ATTEMPTS) {
        taskStatus = "dead";
        store.deadLetterTask(task.id, runId, attempts, err);
      } else {
        taskStatus = "queued"; // back on the queue, gated by the backoff window
        retryAt = Date.now() + retryDelayMs(attempts);
        store.requeueForRetry(task.id, runId, attempts, retryAt, err);
      }
    }

    store.setEmployeeStatus(emp.id, "idle");
    if (r.sessionId) store.setEmployeeSession(emp.id, r.sessionId);
    else if (r.staleSession) store.setEmployeeSession(emp.id, null); // dead resume — start fresh next run

    // real AI spend drains the founder's budget (once per run, not per token)
    if (r.usage.costUsd > 0) {
      const before = store.getCompany(task.companyId);
      const after = store.recordSpend(task.companyId, r.usage.costUsd);
      if (before && after && !isOutOfBudget(before) && isOutOfBudget(after)) {
        this.haltForBudget(after);
      }
    }

    // a completed task ships work — the real counter behind the product version
    if (taskStatus === "done") {
      store.recordShip(task.companyId);
      this.emit({
        runId,
        taskId: task.id,
        employeeId: emp.id,
        kind: "ship",
        message: (r.summary || "shipped work").slice(0, 200),
      });
    }

    // surface a failed run's fate so the feed shows the retry / give-up, not silence
    if (taskStatus === "queued" && retryAt !== null) {
      this.emit({
        runId,
        taskId: task.id,
        employeeId: emp.id,
        kind: "lifecycle",
        message: "task.retry",
        payload: {
          attempts: task.attempts + 1,
          maxAttempts: MAX_TASK_ATTEMPTS,
          retryAt,
          error: r.error,
        },
      });
    } else if (taskStatus === "dead") {
      this.emit({
        runId,
        taskId: task.id,
        employeeId: emp.id,
        kind: "lifecycle",
        message: "task.dead",
        payload: { attempts: task.attempts + 1, error: r.error },
      });
    }

    this.emit({ runId, taskId: task.id, employeeId: emp.id, kind: "status", message: taskStatus });
    this.emit({
      runId,
      taskId: task.id,
      employeeId: emp.id,
      kind: "lifecycle",
      message: "run.end",
      payload: { summary: r.summary, blockedQuestion: r.blockedQuestion, error: r.error },
    });

    // post-run plugin hook
    const co = store.getCompany(task.companyId);
    if (co) {
      const ctx: RunContext = { company: co, employee: emp, task };
      pluginHost.dispatchRunEnd(ctx, {
        ok: taskStatus === "done",
        status: taskStatus,
        summary: r.summary,
        error: r.error,
      });
    }
  }

  private emit(e: Omit<ActivityEvent, "createdAt" | "id">): void {
    const full: ActivityEvent = { ...e, createdAt: Date.now() };
    const id = store.logActivity(full);
    const withId: ActivityEvent = { ...full, id };
    pluginHost.dispatchActivity(withId); // event listeners
    this.events.emit("activity", withId);
  }
}

export const scheduler = new Scheduler();
