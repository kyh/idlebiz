import { setTimeout as delay } from "node:timers/promises";
import { zeroUsage } from "@repo/agent-driver/events";
import type { AgentEvent } from "@repo/agent-driver/events";
import * as store from "@/main/store/store";
import { publishActivity } from "@/main/activity";
import { report } from "@/main/lib/report";
import { agentDriver, askBox } from "@/main/agents/agent-driver";
import type { RunResult, RunTools } from "@/main/agents/agent-driver";
import { announceBet, haltForBudget, say, ship } from "@/main/company-actions";
import { callTool } from "@/main/tools";
import type { RunContext } from "@/main/tools";
import { RUN_COST_ESTIMATE_USD, allocate } from "@/shared/bets";
import type { Allocation } from "@/shared/bets";
import { errorMessage } from "@/shared/errors";
import { RefusalError } from "@/shared/refusal";
import {
  approvalAnswer,
  autonomousBrief,
  founderPing,
  integrationConnectedAnswer,
  routineBrief,
  runPreamble,
} from "@/main/prompts/briefs";
import type { Assignment, TaskBrief } from "@/main/prompts/briefs";
import {
  MAX_TASK_ATTEMPTS,
  hasRole,
  isLead,
  isOutOfBudget,
  isRoutineDue,
  resolveMentions,
} from "@/shared/domain";
import type { Company, Employee, IntegrationKind, Task, TaskStatus } from "@/shared/domain";

const GLOBAL_CONCURRENCY_CAP = 3;

// Reserve capacity for founder requests; queued priority cannot preempt a live run.
const FOUNDER_RESERVED_SLOTS = 1;
const BACKGROUND_CAPACITY = GLOBAL_CONCURRENCY_CAP - FOUNDER_RESERVED_SLOTS;

const AUTOPILOT_TICK_MS = 10_000;

/** An aborted turn settles at once; a shutdown must not hang on a run that never does. */
const SHUTDOWN_GRACE_MS = 2000;

const isWorking = (employeeId: string): boolean =>
  store.getEmployee(employeeId)?.status === "working";

const empName = (id: string): string => store.getEmployee(id)?.name ?? "someone";

/** Run a step nothing above can catch: a fault is reported, and the work after it goes on. */
const guarded = (where: string, step: () => void): void => {
  try {
    step();
  } catch (error) {
    report(where, error);
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
        payload: { kind: ev.kind },
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

/** Gather what the heartbeat brief is grounded in; the prompt module phrases it. */
const heartbeatBrief = (
  company: Company,
  emp: Employee,
  employees: Employee[],
  assignment: Assignment,
): TaskBrief =>
  autonomousBrief({
    assignment,
    bets: store.listBets(),
    company,
    employee: emp,
    employees,
    nameOf: empName,
    problems: store
      .listOpenTasks()
      .filter((t) => t.state.kind === "dead")
      .slice(0, 5),
    products: store.listProducts(),
    room: store.recentTeamMessages(12),
    ships: store.recentShips(),
  });

/** Where the next idle employee goes, by the company's current policy. */
const nextAllocation = (company: Company): Allocation => {
  const stalled = new Set<string>();
  for (const t of store.listOpenTasks()) {
    if (t.betId !== null && t.state.kind === "blocked") {
      stalled.add(t.betId);
    }
  }
  const leadTasks = company.leaderId === null ? [] : store.openTasksFor(company.leaderId);
  return allocate(
    {
      bets: store.listBets(),
      busy: store.runsInFlight(),
      products: store.listProducts().map((p) => p.id),
      proposalPending: leadTasks.some((t) => t.origin === "propose" && t.state.kind === "blocked"),
      runCostUsd: RUN_COST_ESTIMATE_USD,
      stalled,
    },
    store.allocationPolicy(),
  );
};

const admit = (company: Company): boolean => {
  if (!isOutOfBudget(company)) {
    return true;
  }
  haltForBudget(company);
  return false;
};

const book = (task: Task, costUsd: number): void => {
  if (costUsd <= 0) {
    return;
  }
  const before = store.getCompany();
  const after = store.recordSpend(costUsd);
  if (task.betId !== null) {
    store.recordBetSpend(task.betId, costUsd);
  }
  if (before && !isOutOfBudget(before) && isOutOfBudget(after)) {
    haltForBudget(after);
  }
};

/**
 * Usage limits and the app quitting park the task without consuming a retry. A task whose
 * bet stopped taking work while it ran is neither retried nor parked: it dies.
 */
const finish = (runId: string, task: Task, emp: Employee, r: RunResult): void => {
  const at = { employeeId: emp.id, runId, taskId: task.id };
  const o = r.outcome;
  const die = (attempts: number, error: string): TaskStatus => {
    publishActivity({ ...at, kind: "task.dead", payload: { attempts, error } });
    return "dead";
  };
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
      const parked = store.parkTask(task.id, runId, o.until, o.error);
      status = parked?.kind === "dead" ? die(parked.attempts, o.error) : "queued";
      publishActivity({
        ...at,
        kind: "runner.resting",
        payload: { runner: emp.runner, until: o.until },
      });
      break;
    }
    case "interrupted": {
      const error = "Interrupted by app quit";
      const parked = store.parkTask(task.id, runId, Date.now(), error);
      status = parked?.kind === "dead" ? die(parked.attempts, error) : "queued";
      break;
    }
    case "failed": {
      const verdict = store.failTask(task.id, runId, o.error);
      if (verdict?.kind === "dead") {
        status = die(verdict.attempts, o.error);
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

  // a run that was only parked or will retry keeps its sign-off; one that ended does not
  if (status !== "queued") {
    store.revokeApprovals(task.id);
  }
  store.noteRunEnd(emp.id, { instructionsDigest: r.instructionsDigest, sessionId: r.session });

  publishActivity({ ...at, kind: "status", message: status });
};

/** What the scheduler needs of the thing that runs employees; the real one is `agentDriver`. */
export type EmployeeRunner = Pick<typeof agentDriver, "runTask" | "restingRunner" | "pickRunner">;

interface InFlight {
  readonly abort: AbortController;
  /** Resolves once the run has settled and freed its employee. */
  readonly settled: PromiseWithResolvers<void>;
}

class Scheduler {
  private runs = new Map<string, InFlight>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly driver: EmployeeRunner;

  constructor(driver: EmployeeRunner) {
    this.driver = driver;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.stopped = false;
    this.timer = setInterval(() => this.onTick(), AUTOPILOT_TICK_MS);
    this.onTick();
  }

  // Retry queued work even with autopilot off. The timer has no caller to throw to,
  // and a step that faults must not skip the others.
  private onTick(): void {
    guarded("judge bets", () => this.judgeBets());
    guarded("drain queue", () => this.tick());
    guarded("autopilot", () => this.tickAutopilot());
  }

  /** Verdicts come from the real numbers on every tick, autopilot or not: a window closes on its own. */
  private judgeBets(): void {
    const company = store.getCompany();
    if (this.stopped || !company) {
      return;
    }
    for (const bet of store.judgeBets(Date.now())) {
      announceBet(bet);
    }
  }

  /** Stop scheduling; in-flight runs settle on their own. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = null;
  }

  /**
   * Stop scheduling, then abort what is in flight: each run settles as interrupted, and nothing
   * starts after it. Resolves once every run has settled, or at `graceMs` if one never does.
   */
  async shutdown(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    this.stop();
    const settling = [...this.runs.values()].map(({ abort, settled }) => {
      abort.abort();
      return settled.promise;
    });
    await Promise.race([Promise.all(settling), delay(graceMs)]);
  }

  private fireDueRoutines(company: Company, employees: Employee[]): void {
    const now = Date.now();
    for (const r of store.listRoutines()) {
      if (this.runs.size >= BACKGROUND_CAPACITY) {
        break;
      }
      if (!isRoutineDue(r, company.createdAt, now)) {
        continue;
      }
      const idle = employees.filter((e) => e.status === "idle");
      const assignee = (r.role === null ? undefined : idle.find(hasRole(r.role))) ?? idle[0];
      if (!assignee) {
        continue;
      }
      store.markRoutineRun(r.id);
      // a routine is about the company, but its work lands on a product:
      // the one waited on longest, like autopilot's own turn
      this.brief(assignee, routineBrief(r), {
        origin: "routine",
        productId: store.attentionProduct()?.id ?? null,
      });
    }
  }

  private brief(
    emp: Employee,
    brief: TaskBrief,
    filed: Pick<Task, "origin" | "productId"> & Partial<Pick<Task, "betId" | "priority">>,
  ): Task {
    const task = store.createTask({ ...filed, ...brief, assigneeId: emp.id });
    this.queue(task.id, emp.id);
    return task;
  }

  private tickAutopilot(): void {
    if (this.stopped) {
      return;
    }
    const company = store.getCompany();
    if (!company || !company.autopilot || !admit(company)) {
      return;
    }
    const employees = store.listEmployees();
    this.fireDueRoutines(company, employees);
    for (const emp of employees) {
      if (this.runs.size >= BACKGROUND_CAPACITY) {
        break;
      }
      if (emp.status !== "idle") {
        continue;
      }
      if (this.driver.restingRunner(emp.runner) !== null) {
        continue;
      }
      const open = store
        .openTasksFor(emp.id)
        .some((t) => t.state.kind === "queued" || t.state.kind === "running");
      if (open) {
        continue;
      }
      this.heartbeat(company, emp, employees);
    }
  }

  /** Idle hands only spend against a bet; what is left — settling one, opening the next — is the lead's. */
  private heartbeat(company: Company, emp: Employee, employees: Employee[]): void {
    const allocation = nextAllocation(company);
    if (allocation.kind === "wait" || (allocation.kind !== "work" && !isLead(company, emp))) {
      return;
    }
    if (allocation.kind === "propose") {
      const product = allocation.productId === null ? null : store.getProduct(allocation.productId);
      const assignment: Assignment = { kind: "propose", product, widen: allocation.widen };
      this.brief(emp, heartbeatBrief(company, emp, employees, assignment), {
        origin: "propose",
        productId: product?.id ?? null,
      });
      return;
    }
    // a settle run carries its bet too: the call it makes is that bet's cost, and one
    // blocked on the founder stalls the bet like any other work would
    const bet = store.getBet(allocation.betId);
    if (bet) {
      const brief = heartbeatBrief(company, emp, employees, { bet, kind: allocation.kind });
      this.brief(emp, brief, { betId: bet.id, origin: allocation.kind, productId: bet.productId });
    }
  }

  private toolsFor(employee: Employee, company: Company, run: RunContext["run"]): RunTools {
    // The task only turns `blocked` when the run settles, but the ask exists
    // now — so the office raises the "!" over the employee's head at once.
    const asks = askBox((ask) => {
      publishActivity({
        employeeId: employee.id,
        kind: "run.ask",
        payload: { ask },
        runId: run.runId,
        taskId: run.taskId,
      });
    });
    const ctx: RunContext = {
      asks,
      assign: (taskId, employeeId) => {
        this.queue(taskId, employeeId);
      },
      company,
      driver: this.driver,
      employee,
      run,
    };
    return { asks, call: (route, raw) => callTool(ctx, route, raw) };
  }

  /** Whole-token @slug or @first-name mentions wake the addressed employees. */
  founderMessage(text: string): void {
    say(text, null);
    for (const employeeId of resolveMentions(text, store.listEmployees())) {
      this.wakeEmployee(employeeId, founderPing(text));
    }
  }

  /** Direct requests wake the employee without relying on mention parsing. */
  directEmployee(employeeId: string, instruction: string): void {
    const emp = store.getEmployee(employeeId);
    if (!emp) {
      throw new RefusalError(`no employee ${employeeId}`);
    }
    say(`@${emp.id} ${instruction}`, emp.id);
    this.wakeEmployee(employeeId, founderPing(instruction));
  }

  private resumeBlocked(taskId: string, answer: string, whenNotBlocked: string): Task {
    const continuation = store.resolveBlockedWithAnswer(taskId, answer);
    if (!continuation || !continuation.assigneeId) {
      throw new RefusalError(whenNotBlocked);
    }
    return this.assign(continuation.id, continuation.assigneeId);
  }

  answerQuestion(taskId: string, answer: string): Task {
    return this.resumeBlocked(taskId, answer, "task is not awaiting an answer");
  }

  resolveApproval(taskId: string, approved: boolean): Task {
    const task = store.getTask(taskId);
    if (!task || task.state.kind !== "blocked" || task.state.ask.type !== "approval") {
      throw new RefusalError("task is not awaiting an approval");
    }
    const { command } = task.state.ask;
    const continuation = store.resolveBlockedWithAnswer(taskId, approvalAnswer(approved, command));
    if (!continuation?.assigneeId) {
      throw new RefusalError("could not resume the task");
    }
    // Record before the continuation can start: its retry hits the hook again,
    // and must find the sign-off already there.
    if (approved) {
      store.grantApproval(continuation.id, command);
    }
    return this.assign(continuation.id, continuation.assigneeId);
  }

  resumeIntegrationAsks(kind: IntegrationKind): void {
    const company = store.getCompany();
    if (!company) {
      return;
    }
    for (const task of store.listOpenTasks()) {
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
        this.queue(continuation.id, continuation.assigneeId);
      }
    }
  }

  /** Coalesce identical requests still waiting for the same employee. */
  wakeEmployee(employeeId: string, brief: TaskBrief): Task | null {
    const emp = store.getEmployee(employeeId);
    if (!emp) {
      return null;
    }
    const company = store.getCompany();
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
      this.brief(emp, brief, {
        origin: "founder",
        priority: "high",
        productId: store.productOfEmployee(emp.id)?.id ?? null,
      })
    );
  }

  /**
   * Claim even at the budget cap so answered continuations remain queued; a
   * busy assignee picks it up on a later tick. Null only when the claim was lost.
   */
  private queue(taskId: string, employeeId: string): Task | null {
    const claimed = store.claimTask(taskId, employeeId);
    if (!claimed) {
      return null;
    }
    publishActivity({ employeeId, kind: "status", message: "queued", taskId });
    this.tick();
    return store.getTask(taskId) ?? claimed;
  }

  assign(taskId: string, employeeId: string): Task {
    const queued = this.queue(taskId, employeeId);
    if (!queued) {
      throw new RefusalError("task is not assignable");
    }
    return queued;
  }

  tick(): void {
    if (this.stopped) {
      return;
    }
    // Visit each candidate once: a rejected start must not spin on the same task.
    for (const task of store.listQueuedTasks()) {
      if (this.runs.size >= GLOBAL_CONCURRENCY_CAP) {
        break;
      }
      if (this.runs.size >= BACKGROUND_CAPACITY && task.priority !== "high") {
        continue;
      }
      if (task.assigneeId === null || isWorking(task.assigneeId)) {
        continue;
      }
      const employee = store.getEmployee(task.assigneeId);
      if (!employee || this.driver.restingRunner(employee.runner) !== null) {
        continue;
      }
      guarded(`start task ${task.id}`, () => this.startRun(task));
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
    const company = store.getCompany();
    if (!employee || !company) {
      return;
    }
    // Check again at the spawn boundary: queued work may predate the budget cap.
    if (!admit(company)) {
      return;
    }

    const runId = crypto.randomUUID();
    // a lock the save refuses throws with the task still queued: the tick reports it and retries
    const locked = store.lockTaskForRun(task.id, runId);
    // lost race
    if (!locked) {
      return;
    }

    store.setEmployeeStatus(employeeId, "working");
    const inFlight: InFlight = {
      abort: new AbortController(),
      settled: Promise.withResolvers(),
    };
    this.runs.set(runId, inFlight);
    const at = { employeeId, runId, taskId: task.id };
    publishActivity({ ...at, kind: "run.start" });
    publishActivity({ ...at, kind: "status", message: "running" });

    void this.run(runId, task, employee, company, inFlight);
  }

  private async run(
    runId: string,
    task: Task,
    employee: Employee,
    company: Company,
    { abort, settled }: InFlight,
  ): Promise<void> {
    let result: RunResult;
    try {
      result = await this.execute(runId, task, employee, company, abort.signal);
    } catch (error) {
      result = {
        instructionsDigest: employee.instructionsDigest,
        outcome: { error: errorMessage(error), kind: "failed" },
        session: employee.sessionId,
        summary: "",
        usage: zeroUsage(),
      };
    }
    // The money is spent whatever the settle does, and a failed booking must not leave the
    // task running. One settle per run even when it throws: a second would bill $0 and call
    // shipped work failed. Nothing awaits this promise, so each step past here reports its
    // fault instead of rejecting, and the tick guards each start.
    guarded(`book run ${runId}`, () => book(task, result.usage.costUsd));
    guarded(`settle run ${runId}`, () => finish(runId, task, employee, result));
    store.setEmployeeStatus(employee.id, "idle");
    this.runs.delete(runId);
    // sent even when the settle threw before its status: the office and HUD free the employee on it
    guarded(`end run ${runId}`, () => {
      publishActivity({
        employeeId: employee.id,
        kind: "run.end",
        payload: {
          costUsd: result.usage.costUsd,
          outcome: result.outcome,
          summary: result.summary,
        },
        runId,
        taskId: task.id,
      });
    });
    settled.resolve();
    this.tick();
  }

  private execute(
    runId: string,
    task: Task,
    emp: Employee,
    company: Company,
    signal: AbortSignal,
  ): Promise<RunResult> {
    const product = task.productId === null ? null : store.getProduct(task.productId);
    return this.driver.runTask(
      emp,
      company,
      {
        description: `${runPreamble(product, company)}\n\n${task.description ?? ""}`.trim(),
        id: task.id,
        title: task.title,
        workspace: product?.workspaceDir ?? company.workspaceDir,
      },
      (ev: AgentEvent) => onAgentEvent(runId, task, emp, ev),
      this.toolsFor(emp, company, {
        betId: task.betId,
        origin: task.origin,
        productId: task.productId,
        runId,
        taskId: task.id,
      }),
      signal,
    );
  }
}

/** A scheduler over any runner: tests script the runs, the app hands it the CLIs. */
export const createScheduler = (driver: EmployeeRunner): Scheduler => new Scheduler(driver);

export const scheduler = createScheduler(agentDriver);
