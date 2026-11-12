import { isReady, probeRunners } from "@repo/agent-driver/detect";
import type { RunnerProbe } from "@repo/agent-driver/detect";
import { priceUsage } from "@repo/agent-driver/pricing";
import { RUNNERS } from "@repo/agent-driver/registry";
import type { Argv } from "@repo/agent-driver/registry";
import { runAcpTurn } from "@repo/agent-driver/acp-session";
import type { AcpTurnEnd, AcpTurnResult } from "@repo/agent-driver/acp-session";
import { addUsage } from "@repo/agent-driver/events";
import type { AgentEvent, AgentUsage } from "@repo/agent-driver/events";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { z } from "zod";
import type {
  BlockedAsk,
  Company,
  Employee,
  RestingRunners,
  RunOutcome,
  RunSession,
} from "@repo/domain/domain";
import { RUNNER_IDS } from "@repo/domain/runners";
import type { RunnerId } from "@repo/domain/runners";
import { pathWithLauncher } from "../agent-launcher";
import { controlPlane } from "../control-plane";
import type { ToolCaller } from "../control-plane";
import { readJsonFile, writeJsonFile } from "../lib/fs";
import { report } from "../lib/report";
import { runnerRestFile, runBinDir, toolCacheDir, employeeMemoryDir } from "../paths";
import { turnPrompt } from "../prompts/instructions";
import { RefusalError } from "../refusal";
import * as store from "../store/store";
import type { AskBox } from "./ask-box";
import { bundledSkillsDir } from "./bundled-skills";
import { refuseDeniedTools } from "./claude-denies";
import { runTmpdir, toolCacheEnv, ensureRepository, gitIdentity } from "./run-workspace";
import { sandboxedCommand, signInCommand } from "@repo/sandbox/profile";
import type { Sandbox } from "@repo/sandbox/profile";
import { sandboxOf, sandboxRuns } from "./sandbox";
import type { SandboxState } from "./sandbox";
import {
  acpAgentInstalled,
  makeBrowserNamespace,
  permissionGate,
  runnerEnv,
  sessionAgent,
} from "./session";

/** The rests a launch keeps for the next: epoch ms per runner. */
const RestingRunnersSchema = z.object({
  claude: z.number().optional(),
  codex: z.number().optional(),
});

/** Prefer reported dollars; otherwise price tokens at the runner's default model. */
const priceRun = (emp: Employee, usage: AgentUsage): number => {
  if (usage.costUsd > 0) {
    return usage.costUsd;
  }
  if (usage.inputTokens + usage.outputTokens === 0) {
    return 0;
  }
  return priceUsage(RUNNERS[emp.runner].fallbackRates, usage);
};

/** How a turn ended, as its runner now stands (`heed`). */
type TurnOutcome = Extract<RunOutcome, { kind: "done" | "resting" | "signedOut" | "failed" }>;
type Resting = Extract<TurnOutcome, { kind: "resting" }>;

/**
 * How a run ended, as the scheduler settles it. An ask outranks everything: the
 * founder's answer is what the task waits on. A turn the app stopped failed only
 * because it was stopped, so it is not the task's failure.
 */
export const outcomeOf = (
  turn: TurnOutcome,
  ask: BlockedAsk | null,
  interrupted: boolean,
): RunOutcome => {
  if (ask) {
    return { ask, kind: "blocked" };
  }
  return interrupted && turn.kind !== "done" ? { kind: "interrupted" } : turn;
};

/** What a run can reach of the company: its tools over its own socket, and the one ask it may leave the founder. */
export interface RunTools {
  call: ToolCaller;
  asks: AskBox;
}

export interface RunResult {
  outcome: RunOutcome;
  summary: string;
  /** The session to remember for this employee after the run; null forgets it. */
  session: RunSession | null;
  /** Digest of the instructions that session now holds. */
  instructionsDigest: string | null;
  usage: AgentUsage;
}

type Memory = Pick<RunResult, "session" | "instructionsDigest">;

/**
 * What an employee remembers after a turn: the session it ran, holding the instructions it was
 * given. A turn that opened none leaves `stored` exactly as it was; a spent session is forgotten.
 */
export const memoryAfter = (
  turn: Pick<AcpTurnResult, "end" | "sessionId">,
  stored: Memory,
  digest: string,
  workspace: string,
): Memory => {
  if (turn.end.kind === "failed" && turn.end.class === "context") {
    return { instructionsDigest: null, session: null };
  }
  return turn.sessionId === undefined
    ? stored
    : { instructionsDigest: digest, session: { id: turn.sessionId, workspace } };
};

/**
 * The session a run in `workspace` resumes. Only one begun there: claude resumes a session from
 * any folder but the sandbox lets a run write only its own folder's transcripts, so a turn resumed
 * elsewhere is never recorded and the next resume has forgotten it.
 */
export const resumeIn = (session: RunSession | null, workspace: string): string | undefined =>
  session?.workspace === workspace ? session.id : undefined;

/** A turn that says nothing this long is hung, and fails. */
export const RUN_IDLE_TIMEOUT_MS = 10 * 60_000;
/** The longest one turn may run. */
const RUN_MAX_SESSION_MS = 45 * 60_000;

const BACKOFF_MS = 60_000;

/** The longest an overload or a refusal of access rests a runner: a busy provider, or a credential blip, clears in minutes. */
const MAX_BACKOFF_MS = 15 * 60_000;

/** How long the `streak`-th overload or refusal of access in a row rests its runner: 1m, 2m, 4m… up to 15m. */
const backoffMs = (streak: number): number =>
  Math.min(BACKOFF_MS * 2 ** Math.max(0, streak - 1), MAX_BACKOFF_MS);

/**
 * How long a usage limit rests its runner when the provider named no reset. claude names one on
 * its rate limit only once the turn has had a model response, so a turn refused on its first
 * request, as a retried task's usually is, has only its text, which may name none either. Half
 * an hour: a retry refused again costs one spawn and no tokens, and finds a lifted limit at most
 * that late.
 */
const UNNAMED_RESET_REST_MS = 30 * 60_000;

/** The longest a usage limit rests its runner, whatever it named: a parse or a clock gone wrong would park it for days. */
const MAX_USAGE_REST_MS = 12 * 3_600_000;

/** Until when a usage limit rests its runner, by the reset the provider reported, if it did. */
const usageRestUntil = (reportedReset: number | null): number =>
  reportedReset === null
    ? Date.now() + UNNAMED_RESET_REST_MS
    : Math.min(reportedReset, Date.now() + MAX_USAGE_REST_MS);

/**
 * What a pool checks and resolves the sandbox with, finds IdleBiz's skills in and keeps its runners'
 * rests in: tests script them, the app checks and resolves this machine's, the bundled skills and
 * the company's state.
 */
export interface RunnerPoolDeps {
  checkSandbox: () => Promise<SandboxState>;
  /** The sandbox of a run writing `writable`, calling on `apiSocket`, its denials labelled `label`. */
  resolveSandbox: (
    writable: readonly string[],
    apiSocket: string | null,
    label: string | null,
  ) => Promise<Sandbox>;
  skills: () => string;
  /** null before a company is founded. */
  restFile: () => string | null;
}

export class RunnerPool {
  // Boot probes in the background; callers needing a definitive answer await probing.
  private probes: RunnerProbe[] = [];
  private probing: Promise<RunnerProbe[]> = Promise.resolve([]);
  private sandboxing: Promise<SandboxState> = Promise.resolve({
    kind: "refused",
    reason: "IdleBiz has not sandboxed employee runs yet, so none will start.",
  });
  /** What the latest settled check found; null before the first settles. */
  private sandboxed: SandboxState | null = null;
  // runner -> epoch its limit lifts
  private readonly restingUntil = new Map<RunnerId, number>();
  // runner -> overloads and refusals of access in a row, each resting it twice as long as the one before
  private readonly backoffs = new Map<RunnerId, number>();
  // runners whose login a turn found refused; only a sign-in clears one, since its probe reads
  // the stored login, which a revoked token still is
  private readonly refusedLogins = new Set<RunnerId>();
  private readonly checkSandbox: RunnerPoolDeps["checkSandbox"];
  private readonly resolveSandbox: RunnerPoolDeps["resolveSandbox"];
  private readonly skills: RunnerPoolDeps["skills"];
  private readonly restFile: RunnerPoolDeps["restFile"];

  constructor({ checkSandbox, resolveSandbox, restFile, skills }: RunnerPoolDeps) {
    this.checkSandbox = checkSandbox;
    this.resolveSandbox = resolveSandbox;
    this.skills = skills;
    this.restFile = restFile;
  }

  /**
   * Runs wait on the sandbox's check, and never start unsandboxed; a rest the last launch saw still
   * holds. The check, and the look for the CLIs after it, wait for `pathSettled`: both read PATH.
   */
  init(pathSettled: Promise<void> = Promise.resolve()): void {
    this.loadRest();
    this.sandboxing = (async () => {
      await pathSettled;
      return await this.settleSandbox();
    })();
    this.probing = this.probe();
  }

  /** The rests the last launch left, those not yet lifted. */
  private loadRest(): void {
    const file = this.restFile();
    const saved = file === null ? null : readJsonFile(file, RestingRunnersSchema);
    for (const runner of RUNNER_IDS) {
      const until = saved?.[runner];
      if (until !== undefined && until > Date.now()) {
        this.restingUntil.set(runner, until);
      }
    }
  }

  /**
   * Keeps the rests for the next launch. Not critical state: lost, each task waiting on a resting
   * runner spawns once more after a restart, to be refused and parked again, so a write that fails
   * is reported and the run goes on.
   */
  private saveRest(): void {
    const file = this.restFile();
    if (file === null) {
      return;
    }
    try {
      writeJsonFile(file, this.restingRunners());
    } catch (error) {
      report("runner rest", error);
    }
  }

  /** A refusal is written to main's log as well as told to the founder. */
  private async settleSandbox(): Promise<SandboxState> {
    const state = await this.checkSandbox();
    if (state.kind === "refused") {
      report("sandbox", state.reason);
    }
    this.sandboxed = state;
    return state;
  }

  /**
   * Each CLI is looked for under its runner's sandbox, as a run starts it, since the one on PATH
   * could be a run's plant: with no sandbox, none is found.
   */
  private async probe(): Promise<RunnerProbe[]> {
    let probes: RunnerProbe[] = [];
    try {
      const sandbox = await this.sandbox([]);
      probes = await probeRunners(runnerEnv, (runner, argv) =>
        sandboxedCommand(sandbox, runner, argv),
      );
    } catch (error) {
      // a refusal is reported where the check settles
      if (!(error instanceof RefusalError)) {
        report("probe", error);
      }
    }
    this.probes = probes;
    return probes;
  }

  /** `argv` as main starts `runner`'s CLI itself, to sign it in: under a sandbox of no folders, free to open the browser. */
  async sandboxedSignIn(runner: RunnerId, argv: readonly string[]): Promise<Argv> {
    return signInCommand(await this.sandbox([]), runner, argv);
  }

  /** Look for the CLIs again, and check again a sandbox that refused runs: its probe can time out on a loaded boot. */
  refresh(): Promise<RunnerProbe[]> {
    if (this.sandboxed?.kind === "refused") {
      this.sandboxing = this.settleSandbox();
    }
    this.probing = this.probe();
    return this.probing;
  }

  /** Whether a run may start now: only once a check found the sandbox holding, which it then always does. */
  runsSandboxed(): boolean {
    return this.sandboxed?.kind === "sandboxed";
  }

  /** Why no run starts, once the latest check settles; null when runs start sandboxed. */
  async sandboxRefusal(): Promise<string | null> {
    const state = await this.sandboxing;
    return state.kind === "refused" ? state.reason : null;
  }

  /**
   * The sandbox a run writing `writable` starts under, resolved for that run once the check holds:
   * a run calls the company on its own socket and its denials name it.
   */
  private async sandbox(
    writable: readonly string[],
    run: { socket: string; label: string } | null = null,
  ): Promise<Sandbox> {
    const state = await this.sandboxing;
    if (state.kind === "refused") {
      throw new RefusalError(state.reason);
    }
    return await this.resolveSandbox(writable, run?.socket ?? null, run?.label ?? null);
  }

  async hasAnyRunner(): Promise<boolean> {
    await this.probing;
    return this.availableRunners().length > 0;
  }

  /**
   * Whether `runner`'s CLI was last found signed in as its runs sign in, under its sandbox: one that
   * is not (a codex login in the Keychain, which the sandbox closes to codex runs, reads so) would
   * only fail each attempt, so its employees' work waits until a sign-in finds it again.
   */
  signedIn(runner: RunnerId): boolean {
    return this.availableRunners().includes(runner);
  }

  availableRunners(): RunnerId[] {
    // A signed-in CLI still needs its separately packaged ACP adapter.
    return this.probes
      .filter((p) => isReady(p) && acpAgentInstalled(p.id) && !this.refusedLogins.has(p.id))
      .map((p) => p.id);
  }

  /** The runners not signed in, once the latest look for the CLIs settles: whoever runs on one waits. */
  async signedOut(): Promise<RunnerId[]> {
    await this.probing;
    return RUNNER_IDS.filter((runner) => !this.signedIn(runner));
  }

  /** Whether `probe`'s CLI needs a sign-in: installed, and either not signed in or signed in with a login a turn found refused. */
  needsSignIn(probe: RunnerProbe): boolean {
    return probe.installed && (!probe.authed || this.refusedLogins.has(probe.id));
  }

  /** The founder signed `runner` in again, so its turns may try the login anew. */
  signedInAgain(runner: RunnerId): void {
    this.refusedLogins.delete(runner);
  }

  /** Round-robin across ready runners, preferring those without a usage limit. */
  pickRunner(index: number): RunnerId {
    const available = this.availableRunners();
    const awake = available.filter((r) => this.restingRunner(r) === null);
    const pool = awake.length > 0 ? awake : available;
    const runner = pool[index % pool.length];
    if (runner === undefined) {
      throw new Error("no signed-in coding CLI to run on");
    }
    return runner;
  }

  restingRunners(): RestingRunners {
    const resting: RestingRunners = {};
    for (const runner of RUNNER_IDS) {
      const until = this.restingRunner(runner);
      if (until !== null) {
        resting[runner] = until;
      }
    }
    return resting;
  }

  /** Epoch until which this runner's usage limit holds, or null if it's awake. */
  restingRunner(runner: RunnerId): number | null {
    const until = this.restingUntil.get(runner);
    if (until === undefined) {
      return null;
    }
    if (until <= Date.now()) {
      this.restingUntil.delete(runner);
      return null;
    }
    return until;
  }

  /**
   * What a turn's end says of its runner, whatever else the run says, and how the turn ended as
   * the runner now stands: every rest is decided here. A backoff's streak starts over once a turn
   * ends any other way, so a credential blip clears soon and a standing refusal is not hammered. A
   * refused login reads as signed out until the founder signs it in again. A rest never shortens
   * one already holding, which a turn still in flight may end under.
   */
  heed(runner: RunnerId, end: AcpTurnEnd): TurnOutcome {
    const backsOff =
      end.kind === "failed" && (end.class === "overloaded" || end.class === "access-denied");
    const streak = backsOff ? (this.backoffs.get(runner) ?? 0) + 1 : 0;
    this.backoffs.set(runner, streak);
    if (end.kind === "completed") {
      return { kind: "done" };
    }
    switch (end.class) {
      case "auth": {
        this.refusedLogins.add(runner);
        return { error: end.error, kind: "signedOut" };
      }
      case "usage-limit": {
        return this.rest(runner, end.class, end.error, usageRestUntil(end.reportedReset));
      }
      case "overloaded":
      case "access-denied": {
        return this.rest(runner, end.class, end.error, Date.now() + backoffMs(streak));
      }
      case "context":
      case "other": {
        return { error: end.error, kind: "failed" };
      }
      // no default
    }
  }

  /** Rests `runner` until `asked`, or the rest already holding should that lift later, and keeps it for the next launch. */
  private rest(runner: RunnerId, cause: Resting["cause"], error: string, asked: number): Resting {
    const until = Math.max(asked, this.restingRunner(runner) ?? 0);
    this.restingUntil.set(runner, until);
    this.saveRest();
    return { cause, error, kind: "resting", until };
  }

  /** One turn with no tools, files or memory: its final message, or a throw with why it ended short. */
  async completeOneShot(prompt: string): Promise<string> {
    const runner = this.pickRunner(0);
    const res = await runAcpTurn({
      agent: await sessionAgent(runner, await this.sandbox([]), this.skills(), null),
      cwd: tmpdir(),
      idleTimeoutMs: 3 * 60_000,
      maxSessionMs: 5 * 60_000,
      onEvent: () => {
        /* empty */
      },
      onPermission: () => Promise.resolve({ allow: false }),
      prompt: () => prompt,
    });
    const outcome = this.heed(runner, res.end);
    if (outcome.kind !== "done") {
      throw new Error(outcome.error);
    }
    return res.summary;
  }

  async runTask(
    emp: Employee,
    company: Company,
    task: { id: string; title: string; description: string; workspace: string },
    onEvent: (e: AgentEvent) => void,
    tools: RunTools,
    signal: AbortSignal,
  ): Promise<RunResult> {
    const prompt = `${task.title}\n\n${task.description}`.trim();
    const resumeId = resumeIn(emp.session, task.workspace);
    // read at the start, so a change made while the run works reaches the next one
    const instructions = store.employeeInstructions(emp.id);
    const digest = createHash("sha256").update(instructions).digest("hex");
    const run = {
      instructions,
      instructionsChanged: emp.instructionsDigest !== digest,
      prompt,
      taskId: task.id,
      workspace: task.workspace,
    };
    const first = await this.invoke(emp, company, run, onEvent, tools, resumeId, signal);
    // A resumed session that dies without producing any output is almost
    // always stale on the agent's side — retry once fresh before failing.
    const retryFresh =
      first.result.outcome.kind === "failed" && first.turn.resumed && !first.sawOutput;
    if (!retryFresh) {
      const stored = { instructionsDigest: emp.instructionsDigest, session: emp.session };
      return { ...first.result, ...memoryAfter(first.turn, stored, digest, task.workspace) };
    }
    const retry = await this.invoke(emp, company, run, onEvent, tools, undefined, signal);
    // the stale attempt was still billed; each attempt is already priced, so add, don't re-price
    return {
      ...retry.result,
      ...memoryAfter(
        retry.turn,
        { instructionsDigest: digest, session: null },
        digest,
        task.workspace,
      ),
      usage: addUsage(first.result.usage, retry.result.usage),
    };
  }

  private async invoke(
    emp: Employee,
    company: Company,
    run: {
      instructions: string;
      instructionsChanged: boolean;
      prompt: string;
      taskId: string;
      workspace: string;
    },
    onEvent: (e: AgentEvent) => void,
    tools: RunTools,
    resumeSessionId: string | undefined,
    signal: AbortSignal,
  ): Promise<{
    result: Omit<RunResult, "session" | "instructionsDigest">;
    turn: AcpTurnResult;
    sawOutput: boolean;
  }> {
    // the product's workspace is the cwd; the company workspace stays reachable
    // for what is shared across products
    const shared = run.workspace === company.workspaceDir ? [] : [company.workspaceDir];
    const memory = employeeMemoryDir(emp.id);
    const addDirs = [...shared, memory, toolCacheDir()];
    // a run cannot make its own folders, only write in them
    mkdirSync(memory, { recursive: true });
    mkdirSync(runTmpdir(), { recursive: true });
    // the run's own socket, which its sandbox alone lets it connect to: the boundary between runs
    const handle = await controlPlane.registerRun(tools.call);
    let sawOutput = false;
    try {
      const sandbox = await this.sandbox([run.workspace, ...addDirs], {
        label: `${emp.id}/${run.taskId}`,
        socket: handle.socket,
      });
      if (emp.runner === "claude") {
        await refuseDeniedTools();
      }
      makeBrowserNamespace(sandbox, emp.runner);
      if (emp.runner === "claude") {
        // where claude keeps each folder's transcripts and memory, which a run cannot make
        mkdirSync(sandbox.claudeProjects.projects, { recursive: true });
      }
      if (run.workspace !== company.workspaceDir) {
        await ensureRepository(run.workspace);
      }
      const agent = await sessionAgent(emp.runner, sandbox, this.skills(), run.workspace);
      const res = await runAcpTurn({
        addDirs,
        agent,
        cwd: run.workspace,
        env: {
          ...handle.env,
          ...toolCacheEnv(),
          ...gitIdentity(emp, company),
          // the company's tools are the `idlebiz` command, main's own whatever else PATH holds
          PATH: pathWithLauncher(runBinDir(), agent.env.PATH),
        },
        idleTimeoutMs: RUN_IDLE_TIMEOUT_MS,
        maxSessionMs: RUN_MAX_SESSION_MS,
        onEvent: (e) => {
          sawOutput = true;
          // a listener must never break the run
          try {
            onEvent(e);
          } catch (error) {
            report("run.onEvent", error);
          }
        },
        onPermission: permissionGate,
        prompt: (resumed) =>
          turnPrompt({
            changed: run.instructionsChanged,
            instructions: run.instructions,
            resumed,
            task: run.prompt,
          }),
        resumeSessionId,
        signal,
      });
      const usage = { ...res.usage, costUsd: priceRun(emp, res.usage) };
      // an ask raised before the limit hit or the login was refused must not hide it
      const outcome = outcomeOf(
        this.heed(emp.runner, res.end),
        tools.asks.current(),
        signal.aborted,
      );
      return { result: { outcome, summary: res.summary, usage }, sawOutput, turn: res };
    } finally {
      handle.release();
    }
  }
}

/** Where the company keeps its runners' rests; null before one is founded. */
const activeRestFile = (): string | null => (store.getCompany() === null ? null : runnerRestFile());

/**
 * A pool whose runs start only once `checkSandbox` finds the sandbox holding, each under the sandbox
 * `resolveSandbox` gives its own folders then; what `deps` leaves out is this machine's and the
 * company's.
 */
export const createRunnerPool = (deps: Partial<RunnerPoolDeps> = {}): RunnerPool =>
  new RunnerPool({
    checkSandbox: sandboxRuns,
    resolveSandbox: sandboxOf,
    restFile: activeRestFile,
    skills: bundledSkillsDir,
    ...deps,
  });

export const runnerPool = createRunnerPool();
