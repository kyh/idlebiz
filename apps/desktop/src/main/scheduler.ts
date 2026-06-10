import { EventEmitter } from "node:events";
import * as store from "@/main/store/store";
import { piDriver } from "@/main/agents/pi-driver";
import { simulatedMetrics } from "@/main/metrics";
import type { PiEvent } from "@/main/agents/event-parser";
import type { ActivityEvent, Company, Employee, Task, TaskStatus } from "@/shared/domain";

const GLOBAL_CONCURRENCY_CAP = 3;

/**
 * Async run scheduler. Respects a global concurrency cap and a per-employee
 * single-active lock (the busy Set in-process, plus the task's runId lock
 * persisted in its TASK.md). Streams pi events to the activity log + renderer.
 */
const AUTOPILOT_TICK_MS = 10_000;

export class Scheduler {
  readonly events = new EventEmitter();
  private active = new Map<string, string>(); // runId -> employeeId
  private busy = new Set<string>(); // employeeId
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Begin the idle-game loop: idle employees self-direct work while autopilot is on. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tickAutopilot(), AUTOPILOT_TICK_MS);
    this.tickAutopilot();
  }

  /** Fire any routine whose cadence is due, assigned to a matching idle employee. */
  private fireDueRoutines(company: Company, employees: Employee[]): void {
    const now = Date.now();
    for (const r of store.listRoutines(company.id)) {
      if (this.active.size >= GLOBAL_CONCURRENCY_CAP) break;
      if (r.lastRunAt !== null && now - r.lastRunAt < r.intervalHours * 3_600_000) continue;
      const idle = employees.filter((e) => e.status === "idle" && !this.busy.has(e.id));
      const assignee =
        (r.role && idle.find((e) => `${e.role} ${e.title}`.toLowerCase().includes(r.role ?? ""))) || idle[0];
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
    const employees = store.listEmployees(company.id);
    this.fireDueRoutines(company, employees);
    for (const emp of employees) {
      if (this.active.size >= GLOBAL_CONCURRENCY_CAP) break;
      if (emp.status !== "idle" || this.busy.has(emp.id)) continue;
      const open = store.listTasksForEmployee(emp.id).some((t) => t.status === "queued" || t.status === "running");
      if (open) continue;
      const brief = this.autonomousBrief(company, emp, employees);
      const task = store.createTask({ companyId: company.id, title: brief.title, description: brief.description, priority: "medium", assigneeId: emp.id });
      try {
        this.assign(task.id, emp.id);
      } catch {
        /* claim race — picked up next tick */
      }
    }
  }

  /** Prompt for an employee's next autonomous move, grounded in team context. */
  private autonomousBrief(company: Company, emp: Employee, employees: Employee[]): { title: string; description: string } {
    const roster = employees.map((e) => `${e.name} (${e.title})`).join(", ");
    const chat = store.recentActivity(company.id, "chat", 8).map((c) => `- ${c.message ?? ""}`).join("\n") || "(no messages yet)";
    const ships = store.recentActivity(company.id, "ship", 6).map((s) => `- ${s.message ?? ""}`).join("\n") || "(nothing shipped yet)";
    const description = [
      `You are operating autonomously to grow ${company.name}.`,
      `Mission: ${company.mission}`,
      `Your role: ${emp.title}.`,
      `Teammates: ${roster}.`,
      ``,
      `Recent team chat:`,
      chat,
      ``,
      `Recently shipped:`,
      ships,
      ``,
      `Decide the single most valuable next step for the business and DO IT concretely in the shared workspace — build or improve the actual product, fix a real issue, prepare or execute marketing, move toward a public launch. Keep it to one focused chunk you can finish now; build on what the team already did rather than repeating it.`,
      `Make it real: products should end up runnable, and when ready, published (ask the founder via ask_boss before anything outward-facing like deploying or posting).`,
      `Coordinate: if another role should own something, call delegate(role, title, description). When you finish, post a one-line update with message_team(text).`,
      `End with a short summary of exactly what you shipped and where it lives (files, URLs).`,
    ].join("\n");
    return { title: `Advance ${company.name}`, description };
  }

  /** Tools the running agent can call to operate the business with teammates. */
  private hooksFor(emp: Employee, company: Company) {
    return {
      messageTeam: (text: string): void => {
        this.emit({ employeeId: emp.id, kind: "chat", message: text.slice(0, 400) });
      },
      delegate: (role: string, title: string, description: string): void => {
        const want = role.toLowerCase();
        const mate = store
          .listEmployees(company.id)
          .find((e) => e.id !== emp.id && (e.role.toLowerCase() === want || e.title.toLowerCase().includes(want)));
        if (!mate) {
          this.emit({ employeeId: emp.id, kind: "chat", message: `(no "${role}" to delegate "${title}" to)` });
          return;
        }
        const t = store.createTask({ companyId: company.id, title, description, priority: "medium", assigneeId: mate.id });
        this.emit({ employeeId: emp.id, kind: "chat", message: `→ ${mate.name} (${mate.title}): ${title}` });
        try {
          this.assign(t.id, mate.id);
        } catch {
          /* mate busy — runs on a later tick */
        }
      },
    };
  }

  /** Player assigns a task to an employee, then we try to run it. */
  assign(taskId: string, employeeId: string): Task {
    const claimed = store.claimTask(taskId, employeeId);
    if (!claimed) throw new Error("task is not assignable");
    this.emit({ taskId, employeeId, kind: "status", message: "queued" });
    this.tick();
    return store.getTask(taskId)!;
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
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        });
      })
      .finally(() => {
        this.active.delete(runId);
        this.busy.delete(employeeId);
        this.tick();
      });
  }

  private async execute(runId: string, task: Task, emp: Employee, company: Company): Promise<void> {
    const result = await piDriver.runTask(
      emp,
      company,
      { title: task.title, description: task.description },
      (ev: PiEvent) => this.onPiEvent(runId, task, emp, ev),
      this.hooksFor(emp, company),
    );
    this.finish(runId, task, emp, result);
  }

  private onPiEvent(runId: string, task: Task, emp: Employee, ev: PiEvent): void {
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
          this.emit({ runId, taskId: task.id, employeeId: emp.id, kind: "message", message: ev.text.slice(0, 2000) });
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
    r: { ok: boolean; error?: string; summary: string; usage: { inputTokens: number; outputTokens: number; cachedTokens: number }; sessionId?: string; blockedQuestion?: string },
  ): void {
    const taskStatus: TaskStatus = r.blockedQuestion ? "blocked" : r.ok ? "done" : "failed";

    store.releaseTask(task.id, runId, taskStatus, r.summary || r.error || null, r.blockedQuestion ?? null);
    store.setEmployeeStatus(emp.id, "idle");
    if (r.sessionId) store.setEmployeeSession(emp.id, r.sessionId);

    // business metrics: a completed task ships work, drives adoption + revenue
    if (taskStatus === "done") {
      const c = store.getCompany(task.companyId);
      if (c) {
        const boost = simulatedMetrics.onShip(c);
        store.recordShip(task.companyId, boost.usersDelta, boost.cashDelta);
        this.emit({ runId, taskId: task.id, employeeId: emp.id, kind: "ship", message: (r.summary || "shipped work").slice(0, 200), payload: boost });
      }
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
  }

  private emit(e: Omit<ActivityEvent, "createdAt" | "id">): void {
    const full: ActivityEvent = { ...e, createdAt: Date.now() };
    const id = store.logActivity(full);
    this.events.emit("activity", { ...full, id });
  }
}

export const scheduler = new Scheduler();
