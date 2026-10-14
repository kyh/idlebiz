import { setTimeout as delay } from "node:timers/promises";
import { zeroUsage } from "@repo/agent-driver/events";
import type { AgentEvent } from "@repo/agent-driver/events";
import * as store from "./store/store";
import { publishActivity } from "./activity";
import { guarded, report } from "./lib/report";
import { askBox } from "./agents/ask-box";
import type { RunResult, RunTools, RunnerPool } from "./agents/runner-pool";
import { announceBet, haltForBudget, ship } from "./company-actions";
import { stripeInTestMode } from "./metrics";
import { metricsPulse } from "./metrics-pulse";
import type { KeepAwake } from "./keep-awake";
import { callTool } from "./tools";
import type { Integrations, RunContext } from "./tools/define";
import { RUN_COST_ESTIMATE_USD, allocate, isClosed } from "@repo/domain/bets";
import type { Allocation, Bet } from "@repo/domain/bets";
import { errorMessage } from "@repo/domain/errors";
import { verbOf } from "./tool-specs";
import { autonomousBrief, routineBrief, runPreamble } from "./prompts/briefs";
import type { Assignment, TaskBrief } from "./prompts/briefs";
import {
  MAX_TASK_ATTEMPTS,
  hasRole,
  isLead,
  isOutOfBudget,
  isRoutineDue,
} from "@repo/domain/domain";
import type { Company, Employee, RunOrigin, Task, TaskStatus } from "@repo/domain/domain";

const GLOBAL_CONCURRENCY_CAP = 3;

// Reserve capacity for founder requests; queued priority cannot preempt a live run.
const FOUNDER_RESERVED_SLOTS = 1;
const BACKGROUND_CAPACITY = GLOBAL_CONCURRENCY_CAP - FOUNDER_RESERVED_SLOTS;

const AUTOPILOT_TICK_MS = 10_000;

/** How long a proposal that came to nothing holds the lead back: the ledger is not all a brief reads, and the room or a connection may have moved meanwhile. */
const PROPOSAL_RETRY_MS = 15 * 60_000;

/** An aborted turn settles at once; a shutdown must not hang on a run that never does. */
const SHUTDOWN_GRACE_MS = 2000;

const isWorking = (employeeId: string): boolean =>
  store.getEmployee(employeeId)?.status === "working";

const empName = (id: string): string => store.getEmployee(id)?.name ?? "someone";

/** What names set_env in a call's title: its name or its verb. */
const SET_ENV_MARKS = ["set_env", verbOf("set_env")];

const TITLE_LINE_MAX = 160;

/** A tool call's title as one short line: the heredoc bodies a command title carries left out. */
const titleLine = (title: string): string => {
  const [first = ""] = title.trim().split(/[\r\n]/u, 1);
  const line = first.trimEnd();
  return line.length > TITLE_LINE_MAX ? `${line.slice(0, TITLE_LINE_MAX)}…` : line;
};

/**
 * What activity.jsonl keeps, for good, of a tool call's title, which codex makes the command line
 * itself, inlined secrets and all. A set_env call is named alone, judged on the whole title: its
 * value may sit before the verb, on an earlier line or past the cut.
 */
export const loggedToolName = (title: string): string =>
  SET_ENV_MARKS.some((mark) => title.includes(mark)) ? "set_env" : titleLine(title);

const onAgentEvent = (runId: string, task: Task, emp: Employee, ev: AgentEvent): void => {
  const at = { employeeId: emp.id, runId, taskId: task.id };
  switch (ev.type) {
    case "tool_start": {
      publishActivity({
        ...at,
        kind: "tool_call",
        message: loggedToolName(ev.title) || (ev.kind ?? "tool"),
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
    stripeTestMode: stripeInTestMode(),
  });

/**
 * The lead's latest proposal ended done under `PROPOSAL_RETRY_MS` ago, and the ledger has had no
 * news since it was briefed: no bet opened or closed, no product started. The same brief would
 * get the same answer, billed again.
 */
const lastProposalIdle = (leaderId: string, now: number): boolean => {
  const last = store.lastProposalDone(leaderId);
  if (last === null || now >= last.endedAt + PROPOSAL_RETRY_MS) {
    return false;
  }
  const briefed = last.briefedAt;
  const betNews = (bet: Bet): boolean =>
    bet.createdAt > briefed || (isClosed(bet) && bet.state.closedAt > briefed);
  return (
    !store.listBets().some(betNews) && !store.listProducts().some((p) => p.createdAt > briefed)
  );
};

/** Where the next idle employee goes, by the company's current policy. */
const nextAllocation = (company: Company): Allocation => {
  const stalled = new Set<string>();
  for (const t of store.listOpenTasks()) {
    if (t.betId !== null && t.state.kind === "blocked") {
      stalled.add(t.betId);
    }
  }
  const { leaderId } = company;
  const leadTasks = leaderId === null ? [] : store.openTasksFor(leaderId);
  return allocate(
    {
      bets: store.listBets(),
      busy: store.runsInFlight(),
      products: store.listProducts().map((p) => p.id),
      proposalIdle: leaderId !== null && lastProposalIdle(leaderId, Date.now()),
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

/** Back on the queue from `until`, no attempt burned, unless its bet stopped taking work. */
const park = (task: Task, runId: string, until: number, why: string): TaskStatus =>
  store.parkTask(task.id, runId, until, why)?.kind === "dropped" ? "dropped" : "queued";

/**
 * Usage limits, a refused login and the app quitting park the task without consuming a retry.
 * A task whose bet stopped taking work while it ran is neither retried nor parked: it is
 * dropped, and so is its ask to the founder once that bet has closed. A settle run that ends
 * done without the call it was for closes its bet unmeasured.
 */
const settleRun = (
  runId: string,
  task: Task,
  emp: Employee,
  r: RunResult,
  at: { employeeId: string; runId: string; taskId: string },
): TaskStatus => {
  const o = r.outcome;
  switch (o.kind) {
    case "blocked": {
      const settled = store.settleTask(task.id, runId, {
        ask: o.ask,
        kind: "blocked",
        summary: r.summary || null,
      });
      return settled?.kind === "dropped" ? "dropped" : "blocked";
    }
    case "done": {
      store.settleTask(task.id, runId, { kind: "done", summary: r.summary || null });
      ship(task, at, r.summary);
      const unsettled =
        task.origin === "settle" && task.betId !== null
          ? store.closeUnsettledBet(task.betId, Date.now())
          : null;
      if (unsettled) {
        announceBet(unsettled);
      }
      return "done";
    }
    case "resting": {
      const status = park(task, runId, o.until, o.error);
      publishActivity({
        ...at,
        kind: "runner.resting",
        payload: { cause: o.cause, error: o.error, runner: emp.runner, until: o.until },
      });
      return status;
    }
    case "signedOut": {
      return park(task, runId, Date.now(), o.error);
    }
    case "interrupted": {
      return park(task, runId, Date.now(), "Interrupted by app quit");
    }
    case "failed": {
      const verdict = store.failTask(task.id, runId, o.error);
      if (verdict?.kind === "dropped") {
        return "dropped";
      }
      if (verdict?.kind === "dead") {
        publishActivity({
          ...at,
          kind: "task.dead",
          payload: { attempts: verdict.attempts, error: o.error },
        });
        return "dead";
      }
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
      return "queued";
    }
    // no default
  }
};

const finish = (runId: string, task: Task, emp: Employee, r: RunResult): TaskStatus => {
  const at = { employeeId: emp.id, runId, taskId: task.id };
  const status = settleRun(runId, task, emp, r, at);
  // a run that was only parked or will retry keeps its sign-off; one that ended does not
  if (status !== "queued") {
    store.revokeApprovals(task.id);
  }
  store.noteRunEnd(emp.id, { instructionsDigest: r.instructionsDigest, session: r.session });
  publishActivity({ ...at, kind: "status", message: status });
  return status;
};

/** What the scheduler needs of the thing that runs employees; the real one is `runnerPool`. */
export type EmployeeRunner = Pick<
  RunnerPool,
  "runTask" | "restingRunner" | "signedIn" | "pickRunner" | "runsSealed"
>;

/** What a task is filed with beside its brief and its assignee. */
type Filing = { origin: RunOrigin } & Pick<Task, "productId"> &
  Partial<Pick<Task, "betId" | "priority">>;

/** Every run on a product shares its workspace; the company's own work runs in the company's. */
const workspaceOf = (task: Task, company: Company): string => {
  const product = task.productId === null ? null : store.getProduct(task.productId);
  return product?.workspaceDir ?? company.workspaceDir;
};

interface Placement {
  readonly workspace: string;
  /** Carries a founder sign-off, so no other run shares its workspace (`admitsInto`). */
  readonly exclusive: boolean;
}

interface InFlight extends Placement {
  readonly abort: AbortController;
  /** Resolves once the run has settled and freed its employee. */
  readonly settled: PromiseWithResolvers<void>;
}

class Scheduler {
  private readonly runs = new Map<string, InFlight>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly runners: EmployeeRunner;
  private readonly awake: KeepAwake;
  private readonly integrations: Integrations;

  constructor(runners: EmployeeRunner, awake: KeepAwake, integrations: Integrations) {
    this.runners = runners;
    this.awake = awake;
    this.integrations = integrations;
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
    const now = Date.now();
    for (const bet of store.judgeBets(now, metricsPulse.pulsingSince(now))) {
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
      // unmarked it stays due, for a later tick when someone's runner can start it
      const idle = employees.filter((e) => e.status === "idle" && this.canStart(e));
      const assignee = (r.role === null ? undefined : idle.find(hasRole(r.role))) ?? idle[0];
      if (!assignee) {
        continue;
      }
      try {
        store.markRoutineRun(r.id);
      } catch (error) {
        // unmarked it stays due, so briefing it anyway would file it again every tick
        report(`mark routine ${r.id}`, error);
        continue;
      }
      // a routine is about the company, but its work lands on a product:
      // the one waited on longest, like autopilot's own turn
      this.file(assignee, routineBrief(r), {
        origin: "routine",
        productId: store.attentionProduct()?.id ?? null,
      });
    }
  }

  /** Whether the employee's runner could start a run now: signed in and not resting. */
  private canStart(emp: Employee): boolean {
    return this.runners.signedIn(emp.runner) && this.runners.restingRunner(emp.runner) === null;
  }

  private tickAutopilot(): void {
    if (this.stopped) {
      return;
    }
    const company = store.getCompany();
    if (!company || !company.autopilot || !admit(company) || !this.runners.runsSealed()) {
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
      if (!this.canStart(emp)) {
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
      const assignment: Assignment = {
        kind: "propose",
        newProduct: allocation.newProduct,
        product,
        widen: allocation.widen,
      };
      this.file(emp, heartbeatBrief(company, emp, employees, assignment), {
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
      this.file(emp, brief, { betId: bet.id, origin: allocation.kind, productId: bet.productId });
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
      ...this.integrations,
      asks,
      assign: (taskId, employeeId) => {
        this.enqueue(taskId, employeeId);
      },
      company,
      employee,
      run,
      runners: this.runners,
    };
    return { asks, call: (name, raw) => callTool(ctx, name, raw) };
  }

  /** File `brief` for `emp` and queue it, as `enqueue` does. */
  file(emp: Employee, brief: TaskBrief, filing: Filing): Task {
    const task = store.createTask({ ...filing, ...brief, assigneeId: emp.id });
    this.enqueue(task.id, emp.id);
    return task;
  }

  /**
   * Claim even at the budget cap so answered continuations remain queued; a
   * busy assignee picks it up on a later tick. Null only when the claim was lost.
   */
  enqueue(taskId: string, employeeId: string): Task | null {
    const claimed = store.claimTask(taskId, employeeId);
    if (!claimed) {
      return null;
    }
    publishActivity({ employeeId, kind: "status", message: "queued", taskId });
    this.tick();
    return store.getTask(taskId) ?? claimed;
  }

  /**
   * Nothing starts until the seal holds: a run that cannot start sealed would fail, and spend one
   * of its task's attempts, for nothing the task did. The work waits on the queue meanwhile.
   */
  tick(): void {
    const company = store.getCompany();
    if (this.stopped || !company || !this.runners.runsSealed()) {
      return;
    }
    const queued = store.listQueuedTasks();
    const draining = new Set(
      queued
        .filter((t) => store.holdsApproval(t.id) && this.assigneeFree(t))
        .map((t) => workspaceOf(t, company)),
    );
    // Visit each candidate once: a rejected start must not spin on the same task.
    for (const task of queued) {
      if (this.runs.size >= GLOBAL_CONCURRENCY_CAP) {
        break;
      }
      if (this.runs.size >= BACKGROUND_CAPACITY && task.priority !== "high") {
        continue;
      }
      if (!this.assigneeFree(task)) {
        continue;
      }
      const placement: Placement = {
        exclusive: store.holdsApproval(task.id),
        workspace: workspaceOf(task, company),
      };
      if (this.admitsInto(placement, draining)) {
        guarded(`start task ${task.id}`, () => this.startRun(task, placement));
      }
    }
  }

  private assigneeFree(task: Task): boolean {
    if (task.assigneeId === null || isWorking(task.assigneeId)) {
      return false;
    }
    const employee = store.getEmployee(task.assigneeId);
    return employee !== null && this.canStart(employee);
  }

  /**
   * A sign-off pins a command, not the tree it ships, so a signed run waits for its workspace to
   * empty and has it to itself. Nobody new starts there meanwhile: `draining` holds each
   * workspace where a signed run waits with its employee free to start it.
   */
  private admitsInto({ exclusive, workspace }: Placement, draining: ReadonlySet<string>): boolean {
    const peers = [...this.runs.values()].filter((r) => r.workspace === workspace);
    if (exclusive) {
      return peers.length === 0;
    }
    return !draining.has(workspace) && !peers.some((r) => r.exclusive);
  }

  private startRun(task: Task, placement: Placement): void {
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
    if (!locked) {
      return;
    }

    store.setEmployeeStatus(employeeId, "working");
    const inFlight: InFlight = {
      ...placement,
      abort: new AbortController(),
      settled: Promise.withResolvers(),
    };
    this.runs.set(runId, inFlight);
    this.awake.hold(true);
    const at = { employeeId, runId, taskId: task.id };
    // the run is under way and holds the blocker: a start that cannot be told must not strand them
    guarded(`announce run ${runId}`, () => {
      publishActivity({ ...at, kind: "run.start" });
      publishActivity({ ...at, kind: "status", message: "running" });
    });

    void this.run(runId, task, employee, company, inFlight);
  }

  private async run(
    runId: string,
    task: Task,
    employee: Employee,
    company: Company,
    { abort, settled, workspace }: InFlight,
  ): Promise<void> {
    let result: RunResult;
    try {
      result = await this.execute(runId, task, employee, company, workspace, abort.signal);
    } catch (error) {
      result = {
        instructionsDigest: employee.instructionsDigest,
        outcome: { error: errorMessage(error), kind: "failed" },
        session: employee.session,
        summary: "",
        usage: zeroUsage(),
      };
    }
    // The money is spent whatever the settle does, and a failed booking must not leave the
    // task running. One settle per run even when it throws: a second would bill $0 and call
    // shipped work failed. Nothing awaits this promise, so each step past here reports its
    // fault instead of rejecting, and the tick guards each start.
    guarded(`book run ${runId}`, () => book(task, result.usage.costUsd));
    const status = guarded(`settle run ${runId}`, () => finish(runId, task, employee, result));
    guarded(`free ${employee.id} after ${runId}`, () =>
      store.setEmployeeStatus(employee.id, "idle"),
    );
    this.runs.delete(runId);
    this.awake.hold(this.runs.size > 0);
    // sent even when the settle threw before its status: the office and HUD free the employee on it
    guarded(`end run ${runId}`, () => {
      publishActivity({
        employeeId: employee.id,
        kind: "run.end",
        payload: {
          costUsd: result.usage.costUsd,
          outcome: result.outcome,
          settled: status,
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
    workspace: string,
    signal: AbortSignal,
  ): Promise<RunResult> {
    const product = task.productId === null ? null : store.getProduct(task.productId);
    return this.runners.runTask(
      emp,
      company,
      {
        description: `${runPreamble(product, company)}\n\n${task.description ?? ""}`.trim(),
        id: task.id,
        title: task.title,
        workspace,
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

/**
 * A scheduler over any runner and integrations: tests script the runs and fake the keys' calls, the
 * app hands it the CLIs and the real ones. It holds the Mac awake exactly while a run is in flight,
 * so it is the blocker's only owner.
 */
export const createScheduler = (
  runners: EmployeeRunner,
  awake: KeepAwake,
  integrations: Integrations,
): Scheduler => new Scheduler(runners, awake, integrations);

export type { Scheduler };
