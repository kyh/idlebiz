import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { client, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type {
  ClientCapabilities,
  NewSessionRequest,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import { zeroUsage } from "./events";
import { liftsAt, limitOf, readsAsLimit } from "./rate-limit";
import { toolAskOf } from "./tool-ask";
import type { ToolAsk } from "./tool-ask";
import type { AgentEvent, AgentUsage } from "./events";

// One ACP turn. Owns subprocess teardown, watchdogs and usage accounting;
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

// Claude's cost extension reports this process's running total, including on resume.
const RunCost = z.object({ cost: z.object({ amount: z.number() }) });

/** The agent's own account of a tool call, as the policy layer needs it. */
const ToolCallDescription = z.object({ description: z.string().optional() });

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

// Readable.toWeb's Node types conflict with the DOM stream types in the desktop build.
const webReadable = (stream: Readable): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      // Both events can fire; closing twice would mask the original failure.
      let closed = false;
      const close = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        controller.close();
      };
      stream.on("data", (chunk: Buffer) => {
        if (!closed) {
          controller.enqueue(new Uint8Array(chunk));
        }
      });
      stream.on("end", close);
      stream.on("error", close);
    },
  });

const webWritable = (stream: Writable): WritableStream<Uint8Array> =>
  new WritableStream<Uint8Array>({
    close() {
      stream.end();
    },
    write(chunk) {
      stream.write(chunk);
    },
  });

export interface AcpAgent {
  /** Argv of the ACP agent to spawn (e.g. the claude or codex adapter). */
  command: readonly string[];
  /** Session mode to set every turn — see `RunnerAdapter`. */
  sessionModeId: string;
  /** Sent as `_meta` when the session is created or resumed — see `RunnerAdapter`. */
  sessionMeta?: NewSessionRequest["_meta"];
  /** Count the turn from its per-request usage updates — see `RunnerAdapter`. */
  usagePerRequest?: true;
  /** Declare typed session failures on initialize — see `RunnerAdapter`. */
  typedFailures?: true;
  /** The agent's whole environment: nothing of this process's own reaches it unless named here. */
  env: Record<string, string>;
}

/** A tool call an agent wants to make, as the policy layer sees it. */
export interface PermissionRequest {
  tool: ToolAsk;
  /** The agent's own one-line account of what it is doing, when it gives one. */
  description?: string;
  /** ACP tool kind — "execute", "edit", "read", … */
  kind?: string;
}

export interface PermissionDecision {
  allow: boolean;
}

export interface AcpTurnOptions {
  /** Which agent to spawn, and how to make it ask before acting. */
  agent: AcpAgent;
  /** The task, or the wake prompt when resuming. */
  prompt: string;
  /** AGENTS.md instructions: sent to a fresh session, and to a resumed one only when `instructionsChanged`. */
  systemPrompt: string;
  /** The caller's systemPrompt differs from what this resumed session was given, so send it again. */
  instructionsChanged?: boolean;
  /** Working directory — the company workspace where real work lands. */
  cwd: string;
  /** Continue this session instead of starting fresh (the employee's memory). */
  resumeSessionId?: string;
  /** Extra dirs the agent may read/write (e.g. its own memory folder). */
  addDirs?: string[];
  /** Run-scoped additions to the agent's env (the control-plane URL and token, tool caches). */
  env?: Record<string, string>;
  /**
   * Decides tool permissions. Omission allows everything; the caller must provide confinement.
   * `signal` aborts when the turn ends, so an answer that comes too late acts on nothing.
   */
  onPermission?: (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionDecision>;
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

/** How a turn ended: the agent finished it, hit a usage limit or an overload, or something stopped it. */
export type AcpTurnEnd =
  | { readonly kind: "completed" }
  | { readonly kind: "limited"; readonly resetsAt: number; readonly error: string }
  | {
      readonly kind: "failed";
      readonly error: string;
      /** The session is out of context or budget: only a new one can go on. */
      readonly sessionSpent?: true;
    };

export interface AcpTurnResult {
  end: AcpTurnEnd;
  /** The agent's final message (the run summary). */
  summary: string;
  /** Session id — persist it to continue this employee's context later. */
  sessionId?: string;
  /** The stored session was resumed rather than started fresh. */
  resumed: boolean;
  usage: AgentUsage;
}

/** What the session is told this turn: the instructions ride along only when it lacks them. */
const turnText = (opts: AcpTurnOptions, resumed: boolean): string => {
  if (!opts.systemPrompt || (resumed && !opts.instructionsChanged)) {
    return opts.prompt;
  }
  const lead = resumed ? "Your standing instructions changed. They now read:\n\n" : "";
  return `${lead}${opts.systemPrompt}\n\n---\n\nYOUR TASK:\n\n${opts.prompt}`;
};

const TITLE_LINE_MAX = 160;

/**
 * A tool call's title as one short line. codex titles a command with the command itself, heredoc
 * bodies and inlined secrets included, and the caller logs the name for good; the permission
 * policy still judges the whole title.
 */
const titleLine = (title: string): string => {
  const [first = ""] = title.trim().split(/[\r\n]/u, 1);
  const line = first.trimEnd();
  return line.length > TITLE_LINE_MAX ? `${line.slice(0, TITLE_LINE_MAX)}…` : line;
};

/**
 * How a turn ends on the typed failure its agent reported, or null when it reported none. A
 * warning is one the turn got past. A limit rests the runner, unless only a new session can go
 * on. A service fault rests it only when its text tells of an overload: codex-acp types an
 * overload exactly as its catch-all for every error it cannot place, which it did not retry, and
 * resting on one of those would retry a deterministic fault forever. Failing is bounded by attempts.
 */
const failureEnd = (meta: PromptResponse["_meta"]): AcpTurnEnd | null => {
  const parsed = SessionFailureMeta.safeParse(meta);
  if (!parsed.success || parsed.data.jetbrains.air.sessionFailure.severity !== "error") {
    return null;
  }
  const { actions, category, details, title } = parsed.data.jetbrains.air.sessionFailure;
  const error = details === undefined ? title : `${title}\n${details}`;
  if (category === "limit" && actions.includes("new_session")) {
    return { error, kind: "failed", sessionSpent: true };
  }
  if (category === "limit" || (category === "service" && readsAsLimit(error))) {
    return { error, kind: "limited", resetsAt: liftsAt(error) };
  }
  return { error, kind: "failed" };
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no narrower honest type
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
    // stderr is read only when the run fails: kept as chunks, bounded, joined then
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    const keepStderr = (chunk: Buffer): void => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      while (stderrBytes > 2 * STDERR_TAIL_MAX && stderrChunks.length > 1) {
        stderrBytes -= stderrChunks.shift()?.length ?? 0;
      }
    };
    const stderrTail = (): string =>
      Buffer.concat(stderrChunks).toString().slice(-STDERR_TAIL_MAX).trim();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionId: string | undefined;
    let resumed = false;
    let lastMessage = "";
    let pending = "";
    let total = zeroUsage();
    let requestTokens = 0;
    let lastRequestTokens: number | undefined;

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
      usage: total,
    });
    const failed = (error: string): AcpTurnResult => result({ error, kind: "failed" });

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
    if (bin === undefined) {
      settle(failed("no ACP agent command configured"));
      return;
    }

    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        // its own process group, so the backstop can reach the CLI it runs
        detached: true,
        env: { ...opts.agent.env, ...opts.env },
        signal: opts.signal,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      settle(failed(`failed to spawn ${bin}: ${errorMessage(error)}`));
      return;
    }
    unkilled.add(child);

    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) {
      settle(failed(`${bin}: stdio pipes unavailable`));
      return;
    }
    // The agent keeps writing for a moment after we kill it; that EPIPE is
    // expected teardown noise, not a run failure.
    stdin.on("error", () => {
      /* empty */
    });
    stdout.on("error", () => {
      /* empty */
    });
    stderr.on("data", (d: Buffer) => {
      pokeIdle();
      keepStderr(d);
    });
    const died = (code: number | null): void =>
      settle(failed(stderrTail() || `${bin} exited with code ${code} mid-turn`));
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
        const described = ToolCallDescription.safeParse(toolCall.rawInput);
        const request: PermissionRequest = {
          description: described.success ? described.data.description : undefined,
          kind: toolCall.kind ?? undefined,
          tool: toolAskOf({
            kind: toolCall.kind,
            locations: toolCall.locations,
            meta: ctx.params._meta,
            rawInput: toolCall.rawInput,
            title: toolCall.title ?? toolTitles.get(toolCall.toolCallId),
          }),
        };
        const decision = opts.onPermission
          ? await opts.onPermission(request, ended.signal)
          : { allow: true };
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
            toolName: titleLine(update.title) || (update.kind ?? "tool"),
            type: "tool_start",
          });
          return;
        }
        // codex re-sends a request's count unchanged; a repeat is not another request
        if (update.sessionUpdate === "usage_update" && update.used !== lastRequestTokens) {
          requestTokens += update.used;
          lastRequestTokens = update.used;
        }
        const cost = RunCost.safeParse(update);
        if (cost.success && cost.data.cost.amount > total.costUsd) {
          total = { ...total, costUsd: cost.data.cost.amount };
        }
      });

    const stream = ndJsonStream(webWritable(stdin), webReadable(stdout));
    const turn = async (): Promise<void> => {
      const { failure, stopReason } = await app.connectWith(stream, async (agent) => {
        // Required before anything else. claude's adapter tolerates its
        // absence; codex's answers every later call with "Not initialized".
        const init = await agent.request("initialize", {
          clientCapabilities: opts.agent.typedFailures ? TYPED_FAILURES : {},
          clientInfo: { name: "idlebiz", version: "1" },
          protocolVersion: PROTOCOL_VERSION,
        });

        const additionalDirectories = opts.addDirs ?? [];

        // Resume without replaying history; a rejected session id falls back to fresh.
        const resume = async (): Promise<string | undefined> => {
          if (
            opts.resumeSessionId === undefined ||
            !init.agentCapabilities?.sessionCapabilities?.resume
          ) {
            return undefined;
          }
          try {
            await agent.request("session/resume", {
              _meta: opts.agent.sessionMeta,
              additionalDirectories,
              cwd: opts.cwd,
              sessionId: opts.resumeSessionId,
            });
            return opts.resumeSessionId;
          } catch {
            return undefined;
          }
        };
        const resumedId = await resume();
        resumed = resumedId !== undefined;

        const startFresh = async (): Promise<string> => {
          const created = await agent.request("session/new", {
            _meta: opts.agent.sessionMeta,
            additionalDirectories,
            cwd: opts.cwd,
            mcpServers: [],
          });
          return created.sessionId;
        };
        sessionId = resumedId ?? (await startFresh());

        // Fresh or resumed, a session starts in a default mode that may not ask at all, so
        // this runs every turn, and a mode that cannot be set fails the turn before it prompts.
        await agent.request("session/set_mode", {
          modeId: opts.agent.sessionModeId,
          sessionId,
        });

        // a resume may replay what the session spent before
        requestTokens = 0;
        lastRequestTokens = undefined;
        const res = await agent.request("session/prompt", {
          prompt: [{ text: turnText(opts, resumed), type: "text" }],
          sessionId,
        });
        flushMessage();
        const u = res.usage;
        if (u) {
          // Updates carry only each request's total, so the whole turn takes the last
          // request's split. For any other agent `used` is its context size, not a request.
          const scale =
            opts.agent.usagePerRequest && u.totalTokens > 0
              ? Math.max(1, requestTokens / u.totalTokens)
              : 1;
          const scaled = (tokens: number): number => Math.round(tokens * scale);
          total = {
            cachedTokens: scaled(u.cachedReadTokens ?? 0),
            costUsd: total.costUsd,
            inputTokens: scaled((u.inputTokens ?? 0) + (u.cachedWriteTokens ?? 0)),
            outputTokens: scaled(u.outputTokens ?? 0),
          };
        }
        return { failure: failureEnd(res._meta), stopReason: res.stopReason };
      });
      // a synthetic failure's title is generic; codex-acp logs the throw behind it on stderr
      if (failure?.kind === "failed") {
        const tail = stderrTail();
        settle(result(tail ? { ...failure, error: `${failure.error}\n${tail}` } : failure));
        return;
      }
      if (failure) {
        settle(result(failure));
        return;
      }
      if (stopReason === "end_turn" || stopReason === "max_tokens") {
        settle(result({ kind: "completed" }));
        return;
      }
      const tail = stderrTail();
      settle(
        failed(tail ? `agent stopped: ${stopReason}\n${tail}` : `agent stopped: ${stopReason}`),
      );
    };
    void (async () => {
      try {
        await turn();
      } catch (error) {
        if (error instanceof RequestError) {
          const limit = limitOf(error);
          settle(
            limit
              ? result({ error: error.message, kind: "limited", resetsAt: limit.resetsAt })
              : failed(error.message),
          );
          return;
        }
        // Anything else is the connection dropping, and a dying agent drops it before its exit
        // can report the stderr that says why: that report wins unless no exit follows.
        setTimeout(() => settle(failed(errorMessage(error))), DROPPED_CONNECTION_GRACE_MS).unref();
      }
    })();
  });
