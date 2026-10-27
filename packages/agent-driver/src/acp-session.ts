import { spawn } from "node:child_process";
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { client, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type {
  ClientCapabilities,
  NewSessionRequest,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import { errorMessage } from "@repo/domain/errors";
import { usageMeter } from "./acp-usage";
import { classOfRequestError, classOfTypedFailure, liftsAt } from "./rate-limit";
import type { FailureClass } from "./rate-limit";
import { toolAskOf } from "./tool-ask";
import type { ToolAsk } from "./tool-ask";
import type { AgentEvent, AgentUsage } from "./events";
import type { Argv } from "./registry";

// One ACP turn. Owns subprocess teardown and watchdogs, and bills what `usageMeter` counts;
// adapters own the CLI wire formats.

/** Keep only the tail of stderr — used solely for final error reporting. */
const STDERR_TAIL_MAX = 16_000;

/** Human-friendly duration for watchdog messages ("45m", "3s"). */
const fmtMs = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;

/** Longer than the 2s both adapters give their CLI after stdin closes before signalling it. */
const TEARDOWN_GRACE_MS = 5000;

/** How long an exited agent's pipes get to close: its own children can hold them open for good. */
const EXIT_CLOSE_GRACE_MS = 250;

/** How long a dropped connection waits for the agent's exit, which says why it died. */
const DROPPED_CONNECTION_GRACE_MS = 1000;

/** How a client declares codex-acp's typed session failures (the JetBrains AIR extension). */
const TYPED_FAILURES: ClientCapabilities = {
  _meta: { jetbrains: { air: { capabilities: ["sessionFailure"], version: 1 } } },
};

/** A declared typed failure, as it rides on the prompt response that ends the turn. */
const SessionFailureMeta = z.object({
  jetbrains: z.object({
    air: z.object({
      sessionFailure: z.object({
        actions: z.array(z.string()),
        category: z.string(),
        details: z.string().optional(),
        severity: z.string(),
        title: z.string(),
      }),
    }),
  }),
});

/** The agent a turn spawns. Its session fields are a `RunnerAdapter`'s, which says why each is. */
export interface AcpAgent {
  /** Argv of the ACP agent to spawn (e.g. the claude or codex adapter). */
  command: Argv;
  /** Session mode to set every turn. */
  sessionModeId: string;
  /** Sent as `_meta` when the session is created or resumed. */
  sessionMeta?: NewSessionRequest["_meta"];
  /** Folders every session is handed besides the turn's `addDirs`, to read. */
  readDirs?: readonly string[] | undefined;
  /** Count the turn from its per-request usage updates. */
  usagePerRequest?: true | undefined;
  /** Declare typed session failures on initialize. */
  typedFailures?: true | undefined;
  /** The agent's whole environment: nothing of this process's own reaches it unless named here. */
  env: Record<string, string>;
}

export interface PermissionDecision {
  allow: boolean;
}

export interface AcpTurnOptions {
  /** Which agent to spawn, and how to make it ask before acting. */
  agent: AcpAgent;
  /** The turn's text, given whether the stored session was resumed. */
  prompt: (resumed: boolean) => string;
  /** Working directory: where the turn's work lands. */
  cwd: string;
  /** Continue this session instead of starting fresh (the employee's memory). */
  resumeSessionId?: string | undefined;
  /** Extra dirs the agent may read/write (e.g. its own memory folder). */
  addDirs?: string[];
  /** Run-scoped additions to the agent's env (its line to the company, tool caches, PATH). */
  env?: Record<string, string>;
  /**
   * Decides each tool call the agent asks to make. `signal` aborts when the turn ends, so an
   * answer that comes too late acts on nothing.
   */
  onPermission: (tool: ToolAsk, signal: AbortSignal) => Promise<PermissionDecision>;
  /** Kill + fail after this long with NO output (wedged process). 0 disables. */
  idleTimeoutMs: number;
  /** Absolute ceiling on one turn regardless of activity. 0 disables. */
  maxSessionMs: number;
  /** Aborts the underlying process. */
  signal?: AbortSignal;
  /** How long an ended turn's agent gets to shut down before its process group is killed. */
  teardownGraceMs?: number;
  /** Receives normalized events as the turn streams. */
  onEvent: (e: AgentEvent) => void;
}

/**
 * How a turn ended: the agent finished it, or it failed, with what the failure says of its runner
 * (`class`) and the agent's words. The caller decides what a class costs the runner: a sign-in, a
 * rest, a spent session or only the task's attempt.
 */
export type AcpTurnEnd =
  | { readonly kind: "completed" }
  | {
      readonly kind: "failed";
      readonly class: "usage-limit";
      readonly error: string;
      /** When the provider said the limit lifts, epoch ms; null when it named no time. */
      readonly reportedReset: number | null;
    }
  | {
      readonly kind: "failed";
      readonly class: Exclude<FailureClass, "usage-limit">;
      readonly error: string;
    };

type TurnFailure = Extract<AcpTurnEnd, { kind: "failed" }>;

export interface AcpTurnResult {
  end: AcpTurnEnd;
  /** The agent's final message (the run summary). */
  summary: string;
  /** Session id — persist it to continue this employee's context later. */
  sessionId?: string | undefined;
  /** The stored session was resumed rather than started fresh. */
  resumed: boolean;
  usage: AgentUsage;
}

/**
 * How a turn ends on a failure of class `failure`: a usage limit with when the provider said it
 * lifts, on the rate limit it `reported` or in its `error`'s words.
 */
const endOf = (failure: FailureClass, error: string, reported: number | null): TurnFailure =>
  failure === "usage-limit"
    ? { class: failure, error, kind: "failed", reportedReset: liftsAt(error, reported) }
    : { class: failure, error, kind: "failed" };

/**
 * How a turn ends on the typed failure its agent reported, or null when it reported none. A
 * warning is one the turn got past.
 */
const failureEnd = (meta: PromptResponse["_meta"], reported: number | null): TurnFailure | null => {
  const parsed = SessionFailureMeta.safeParse(meta);
  if (!parsed.success || parsed.data.jetbrains.air.sessionFailure.severity !== "error") {
    return null;
  }
  const { actions, category, details, title } = parsed.data.jetbrains.air.sessionFailure;
  const error = details === undefined ? title : `${title}\n${details}`;
  return endOf(classOfTypedFailure({ actions, category, text: error }), error, reported);
};

/** What an agent wrote to stderr, read only when its turn fails: kept as chunks, bounded, joined then. */
const stderrTail = () => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    keep: (chunk: Buffer): void => {
      chunks.push(chunk);
      bytes += chunk.length;
      while (bytes > 2 * STDERR_TAIL_MAX && chunks.length > 1) {
        bytes -= chunks.shift()?.length ?? 0;
      }
    },
    text: (): string => Buffer.concat(chunks).toString().slice(-STDERR_TAIL_MAX).trim(),
  };
};

/** Every agent spawned whose process group has not been killed yet, its leader alive or not. */
const unkilled = new Set<ChildProcess>();

// Even once the leader is gone: codex-acp dies on SIGTERM without stopping its app-server,
// and a group's id cannot be reused while any member of it lives. Once only: after that it can.
const killGroup = (child: ChildProcess): void => {
  if (!unkilled.delete(child) || child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* group already gone */
  }
};

const leaderExit = async (child: ChildProcess): Promise<void> => {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    await once(child, "exit");
  } catch {
    /* it reported an error instead: nothing left to wait for */
  }
};

/**
 * For a process about to exit, where no backstop will fire: asks every agent still working to
 * stop, waits up to `graceMs` for them to shut down, then kills every agent's process group. A
 * group whose leader has exited is not waited on, since nothing is left in it to stop the rest.
 */
export const endAllAgents = async (graceMs = TEARDOWN_GRACE_MS): Promise<void> => {
  for (const child of unkilled) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  await Promise.race([Promise.all([...unkilled].map(leaderExit)), delay(graceMs)]);
  for (const child of unkilled) {
    killGroup(child);
  }
};

export const runAcpTurn = (opts: AcpTurnOptions): Promise<AcpTurnResult> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps a callback API (child process and ACP client events)
  new Promise((resolve) => {
    let child: ChildProcess | undefined;
    let settled = false;
    const ended = new AbortController();
    const agentStderr = stderrTail();
    const usage = usageMeter(opts.agent.usagePerRequest === true);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionId: string | undefined;
    let resumed = false;
    let lastMessage = "";
    let pending = "";

    // ACP has no message-end marker. Flush prose before a tool call or at turn end.
    const flushMessage = (): void => {
      const text = pending.trim();
      pending = "";
      if (!text) {
        return;
      }
      lastMessage = text;
      opts.onEvent({ text, type: "message_end" });
    };

    const settle = (res: AcpTurnResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      ended.abort();
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      if (sessionTimer) {
        clearTimeout(sessionTimer);
      }
      // Both adapters tear down their CLI and its tools on stdin EOF or SIGTERM; an
      // immediate SIGKILL would skip the CLI's cleanup of its own detached tool groups.
      // The group kill is only for an agent that is still wedged after the grace period.
      if (child) {
        const ending = child;
        try {
          ending.stdin?.destroy();
          ending.stdout?.destroy();
          ending.stderr?.destroy();
          if (!ending.killed) {
            ending.kill("SIGTERM");
          }
          ending.unref();
        } catch {
          /* already gone */
        }
        const backstop = setTimeout(
          () => killGroup(ending),
          opts.teardownGraceMs ?? TEARDOWN_GRACE_MS,
        );
        backstop.unref();
      }
      resolve(res);
    };

    /** A turn that died mid-flight still spent what it spent. */
    const result = (end: AcpTurnEnd): AcpTurnResult => ({
      end,
      resumed,
      sessionId,
      summary: lastMessage,
      usage: usage.total(),
    });
    /** A failure no agent reported (a watchdog, a crash, a refused spawn): only the task's. */
    const failed = (error: string): AcpTurnResult =>
      result({ class: "other", error, kind: "failed" });

    const pokeIdle = (): void => {
      if (opts.idleTimeoutMs <= 0 || settled) {
        return;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        settle(failed(`no output for ${fmtMs(opts.idleTimeoutMs)} — treating the agent as hung`));
      }, opts.idleTimeoutMs);
      idleTimer.unref?.();
    };

    const [bin, ...args] = opts.agent.command;

    let spawned: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      spawned = spawn(bin, args, {
        cwd: opts.cwd,
        // its own process group, so the backstop can reach the CLI it runs
        detached: true,
        env: { ...opts.agent.env, ...opts.env },
        signal: opts.signal,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child = spawned;
    } catch (error) {
      settle(failed(`failed to spawn ${bin}: ${errorMessage(error)}`));
      return;
    }
    unkilled.add(spawned);

    const { stdin, stdout, stderr } = spawned;
    // Node's adapters hear each pipe's errors: one mid-turn fails the turn in its own words, and one
    // once the turn has ended reaches nothing that still awaits
    const output: WritableStream<Uint8Array> = Writable.toWeb(stdin);
    const input: ReadableStream<Uint8Array> = Readable.toWeb(stdout);
    stderr.on("data", (d: Buffer) => {
      pokeIdle();
      agentStderr.keep(d);
    });
    const died = (code: number | null): void =>
      settle(failed(agentStderr.text() || `${bin} exited with code ${code} mid-turn`));
    child.on("error", (err: Error) => settle(failed(`${bin}: ${err.message}`)));
    child.on("close", died);
    child.on("exit", (code) => setTimeout(() => died(code), EXIT_CLOSE_GRACE_MS).unref());

    pokeIdle();
    if (opts.maxSessionMs > 0) {
      sessionTimer = setTimeout(() => {
        settle(failed(`exceeded the ${fmtMs(opts.maxSessionMs)} session limit — killed`));
      }, opts.maxSessionMs);
      sessionTimer.unref?.();
    }

    const toolTitles = new Map<string, string>();
    const app = client({ name: "idlebiz" })
      .onRequest("session/request_permission", async (ctx) => {
        if (settled) {
          return { outcome: { outcome: "cancelled" } };
        }
        pokeIdle();
        const { toolCall } = ctx.params;
        const tool = toolAskOf({
          kind: toolCall.kind,
          meta: ctx.params._meta,
          rawInput: toolCall.rawInput,
          title: toolCall.title ?? toolTitles.get(toolCall.toolCallId),
        });
        const decision = await opts.onPermission(tool, ended.signal);
        // Match protocol kinds, not adapter-specific ids. Only one-command approval:
        // an allow_always would outlive the founder's signature.
        const pick = (kind: string): string | undefined =>
          ctx.params.options.find((o) => o.kind === kind)?.optionId;
        const optionId = decision.allow
          ? pick("allow_once")
          : (pick("reject_once") ?? pick("reject_always"));
        if (optionId === undefined) {
          return { outcome: { outcome: "cancelled" } };
        }
        return { outcome: { optionId, outcome: "selected" } };
      })
      .onNotification("session/update", (ctx) => {
        pokeIdle();
        const { update } = ctx.params;
        if (update.sessionUpdate === "agent_message_chunk") {
          if (update.content.type === "text") {
            pending += update.content.text;
          }
          return;
        }
        if (update.sessionUpdate === "tool_call") {
          toolTitles.set(update.toolCallId, update.title);
          flushMessage();
          opts.onEvent({
            kind: update.kind ?? undefined,
            title: update.title,
            type: "tool_start",
          });
          return;
        }
        usage.onUpdate(update);
      });

    const stream = ndJsonStream(output, input);
    const turn = async (): Promise<void> => {
      const { failure, stopReason } = await app.connectWith(stream, async (agent) => {
        // Required before anything else. claude's adapter tolerates its
        // absence; codex's answers every later call with "Not initialized".
        const init = await agent.request("initialize", {
          clientCapabilities: opts.agent.typedFailures ? TYPED_FAILURES : {},
          clientInfo: { name: "idlebiz", version: "1" },
          protocolVersion: PROTOCOL_VERSION,
        });

        const scope: Pick<NewSessionRequest, "_meta" | "additionalDirectories" | "cwd"> = {
          additionalDirectories: [...(opts.addDirs ?? []), ...(opts.agent.readDirs ?? [])],
          cwd: opts.cwd,
        };
        if (opts.agent.sessionMeta !== undefined) {
          scope._meta = opts.agent.sessionMeta;
        }

        // Resume without replaying history; a rejected session id falls back to fresh.
        const resume = async (): Promise<string | undefined> => {
          if (
            opts.resumeSessionId === undefined ||
            !init.agentCapabilities?.sessionCapabilities?.resume
          ) {
            return undefined;
          }
          try {
            await agent.request("session/resume", { ...scope, sessionId: opts.resumeSessionId });
            return opts.resumeSessionId;
          } catch {
            return undefined;
          }
        };
        const resumedId = await resume();
        resumed = resumedId !== undefined;

        const startFresh = async (): Promise<string> => {
          const created = await agent.request("session/new", { ...scope, mcpServers: [] });
          return created.sessionId;
        };
        sessionId = resumedId ?? (await startFresh());

        // Fresh or resumed, a session starts in a default mode that may not ask at all, so
        // this runs every turn, and a mode that cannot be set fails the turn before it prompts.
        await agent.request("session/set_mode", {
          modeId: opts.agent.sessionModeId,
          sessionId,
        });

        usage.startPrompt();
        const res = await agent.request("session/prompt", {
          prompt: [{ text: opts.prompt(resumed), type: "text" }],
          sessionId,
        });
        flushMessage();
        usage.onResponse(res.usage);
        return {
          failure: failureEnd(res._meta, usage.rateLimitReset()),
          stopReason: res.stopReason,
        };
      });
      if (failure !== null) {
        // a synthetic failure's title is generic; codex-acp logs the throw behind it on stderr. A
        // failure of the runner's keeps only the provider's words, which the founder is shown.
        const tail =
          failure.class === "other" || failure.class === "context" ? agentStderr.text() : "";
        settle(result(tail ? { ...failure, error: `${failure.error}\n${tail}` } : failure));
        return;
      }
      if (stopReason === "end_turn" || stopReason === "max_tokens") {
        settle(result({ kind: "completed" }));
        return;
      }
      const tail = agentStderr.text();
      settle(
        failed(tail ? `agent stopped: ${stopReason}\n${tail}` : `agent stopped: ${stopReason}`),
      );
    };
    void (async () => {
      try {
        await turn();
      } catch (error) {
        if (error instanceof RequestError) {
          // only the agent's own rejection is read: a watchdog's or a crash's text never is
          settle(result(endOf(classOfRequestError(error), error.message, usage.rateLimitReset())));
          return;
        }
        // Anything else is the connection dropping, and a dying agent drops it before its exit
        // can report the stderr that says why: that report wins unless no exit follows.
        setTimeout(() => settle(failed(errorMessage(error))), DROPPED_CONNECTION_GRACE_MS).unref();
      }
    })();
  });
