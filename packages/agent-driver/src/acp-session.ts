import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { zeroUsage, type AgentEvent, type AgentUsage } from "./events";

// ---------------------------------------------------------------------------
// One ACP turn, start to finish.
//
// Every runner is an ACP agent: spawn it, speak the protocol over its stdio,
// send one turn, settle. Wire formats are the protocol's problem now rather
// than ours — there is no per-CLI stdout parsing left.
//
// What ACP does NOT give us, and this file still owns:
//  - watchdogs. A wedged agent must never hang the scheduler, and the protocol
//    has no timeout of its own.
//  - resolve-exactly-once with the child torn down. A killed child's orphaned
//    grandchild can hold stdout open long after we have our answer.
//  - usage that survives a kill, so a run aborted for budget still reports what
//    it actually spent.
// ---------------------------------------------------------------------------

/** Keep only the tail of stderr — used solely for final error reporting. */
const STDERR_TAIL_MAX = 16_000;

/** Human-friendly duration for watchdog messages ("45m", "3s"). */
const fmtMs = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;

/**
 * What an agent reports while a turn is still running.
 *
 * ACP has no usage channel of its own, so this is an agent extension and is
 * read by shape. Claude sends a running dollar total here; codex sends nothing
 * until the turn completes. It is the only thing standing between a spend cap
 * and a run that blows through it, so a wrong field name costs the ceiling
 * silently — nothing fails, the cap just stops being enforced.
 */
const LiveSpend = z.object({ cost: z.object({ amount: z.number() }).loose() }).loose();

/** The agent's own account of a tool call, as the policy layer needs it. */
const ToolCallInput = z
  .object({ command: z.string().optional(), description: z.string().optional() })
  .loose();

/**
 * Node stream → web stream.
 *
 * `Readable.toWeb` would do this in one line, and it typechecks fine inside
 * this package — but this file is compiled again as part of the desktop app,
 * whose tsconfig pulls in the DOM lib, and there `ReadableStream<any>` and the
 * DOM's `ReadableStream<Uint8Array>` are not assignable. Written out so both
 * builds agree, without an assertion papering over the difference.
 */
function webReadable(stream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // `end` and `error` can both fire, and closing twice throws — which
      // surfaces as a teardown crash instead of the real run failure.
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        controller.close();
      };
      stream.on("data", (chunk: Buffer) => {
        if (!closed) controller.enqueue(new Uint8Array(chunk));
      });
      stream.on("end", close);
      stream.on("error", close);
    },
  });
}

function webWritable(stream: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      stream.write(chunk);
    },
    close() {
      stream.end();
    },
  });
}

export interface AcpAgent {
  /** Argv of the ACP agent to spawn (e.g. the claude or codex adapter). */
  command: readonly string[];
  /** Session mode to select once the session exists — see `RunnerAdapter`. */
  sessionModeId?: string;
  /** Environment this agent needs to find its own CLI. */
  env?: Record<string, string>;
}

/** A tool call an agent wants to make, as the policy layer sees it. */
export interface PermissionRequest {
  /** The shell command, or the tool call's title when it isn't a command. */
  command: string;
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
  /**
   * Durable instructions (the employee's AGENTS.md body), sent only when a
   * fresh session is opened. A resumed session already carries them, so
   * re-sending would re-pay for the whole prompt on every wake.
   */
  systemPrompt: string;
  /** Working directory — the company workspace where real work lands. */
  cwd: string;
  /** Continue this session instead of starting fresh (the employee's memory). */
  resumeSessionId?: string;
  /** Extra dirs the agent may read/write (e.g. its own agent package dir). */
  addDirs?: string[];
  /** Run-scoped env additions (control-plane URL + token, secrets). */
  env?: Record<string, string>;
  /**
   * Decides whether a tool call may proceed, in-process, for every permission
   * request the agent raises.
   *
   * Omitting it allows everything, which is only right for a runner the caller
   * has already confined some other way.
   */
  onPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /** Kill + fail after this long with NO output (wedged process). 0 disables. */
  idleTimeoutMs: number;
  /** Absolute ceiling on one turn regardless of activity. 0 disables. */
  maxSessionMs: number;
  /** Aborts the underlying process. */
  signal?: AbortSignal;
  /** Receives normalized events as the turn streams. */
  onEvent: (e: AgentEvent) => void;
}

/** How a turn ended: the agent finished its turn, or something stopped it. */
export type AcpTurnEnd =
  | { readonly kind: "completed" }
  | { readonly kind: "failed"; readonly error: string };

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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no narrower honest type
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function runAcpTurn(opts: AcpTurnOptions): Promise<AcpTurnResult> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess | undefined;
    let settled = false;
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
    let billed = 0;
    let total = zeroUsage();

    /**
     * Release what the agent has said so far as one feed line.
     *
     * ACP streams prose in chunks with no end-of-message marker, so a boundary
     * has to be chosen: a tool call, or the end of the turn. Without this the
     * office shows tool calls and no narration at all — every employee works
     * in silence, which is most of what the team room is for.
     */
    const flushMessage = (): void => {
      const text = pending.trim();
      pending = "";
      if (!text) return;
      lastMessage = text;
      opts.onEvent({ type: "message_end", text });
    };

    const settle = (res: AcpTurnResult): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (sessionTimer) clearTimeout(sessionTimer);
      try {
        child?.stdin?.destroy();
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.kill("SIGKILL");
        child?.unref();
      } catch {
        /* already gone */
      }
      resolvePromise(res);
    };

    /** A turn that died mid-flight still spent what it spent. */
    const result = (end: AcpTurnEnd): AcpTurnResult => ({
      end,
      summary: lastMessage,
      sessionId,
      resumed,
      usage: total,
    });
    const failed = (error: string): AcpTurnResult => result({ kind: "failed", error });

    const pokeIdle = (): void => {
      if (opts.idleTimeoutMs <= 0 || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
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
        env: { ...process.env, ...opts.agent.env, ...opts.env },
        stdio: ["pipe", "pipe", "pipe"],
        signal: opts.signal,
      });
    } catch (err) {
      settle(failed(`failed to spawn ${bin}: ${errorMessage(err)}`));
      return;
    }

    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) {
      settle(failed(`${bin}: stdio pipes unavailable`));
      return;
    }
    // The agent keeps writing for a moment after we kill it; that EPIPE is
    // expected teardown noise, not a run failure.
    stdin.on("error", () => {});
    stdout.on("error", () => {});
    stderr.on("data", (d: Buffer) => {
      pokeIdle();
      keepStderr(d);
    });
    child.on("error", (err: Error) => settle(failed(`${bin}: ${err.message}`)));
    child.on("close", (code) =>
      settle(failed(stderrTail() || `${bin} exited with code ${code} mid-turn`)),
    );

    pokeIdle();
    if (opts.maxSessionMs > 0) {
      sessionTimer = setTimeout(() => {
        settle(failed(`exceeded the ${fmtMs(opts.maxSessionMs)} session limit — killed`));
      }, opts.maxSessionMs);
      sessionTimer.unref?.();
    }

    const app = client({ name: "idlebiz" })
      .onRequest("session/request_permission", async (ctx) => {
        pokeIdle();
        const tool = ToolCallInput.safeParse(ctx.params.toolCall.rawInput);
        const input = tool.success ? tool.data : {};
        const request: PermissionRequest = {
          command: input.command ?? ctx.params.toolCall.title ?? "",
          description: input.description,
          kind: ctx.params.toolCall.kind ?? undefined,
        };
        const decision = opts.onPermission ? await opts.onPermission(request) : { allow: true };
        // `kind` is a required, spec'd discriminant — matching on option id
        // prefixes would guess at agent-specific spellings and could pick
        // something like "allowlist_edit". Prefer the once-only option: one
        // yes buys one command, which is what the approval card promises.
        const pick = (kind: string): string | undefined =>
          ctx.params.options.find((o) => o.kind === kind)?.optionId;
        const optionId = decision.allow
          ? (pick("allow_once") ?? pick("allow_always"))
          : (pick("reject_once") ?? pick("reject_always"));
        if (optionId === undefined) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId } };
      })
      .onNotification("session/update", (ctx) => {
        pokeIdle();
        const update = ctx.params.update;
        if (update.sessionUpdate === "agent_message_chunk") {
          if (update.content.type === "text") pending += update.content.text;
          return;
        }
        if (update.sessionUpdate === "tool_call") {
          // Whatever the agent was saying is finished the moment it acts, so
          // the feed gets the line before the tool call that followed it.
          flushMessage();
          opts.onEvent({
            type: "tool_start",
            toolName: update.title || update.kind || "tool",
            kind: update.kind ?? undefined,
            args: update.rawInput,
          });
          return;
        }
        // Live spend, so the budget can stop a run in flight rather than at
        // the next boundary.
        const live = LiveSpend.safeParse(update);
        if (!live.success) return;
        const spent = live.data.cost.amount;
        if (spent > billed) {
          opts.onEvent({ type: "usage", usage: { ...zeroUsage(), costUsd: spent - billed } });
          billed = spent;
          // carried on the result as it grows, so a run killed mid-flight still reports it
          total = { ...total, costUsd: billed };
        }
      });

    const stream = ndJsonStream(webWritable(stdin), webReadable(stdout));
    void app
      .connectWith(stream, async (agent) => {
        // Required before anything else. claude's adapter tolerates its
        // absence; codex's answers every later call with "Not initialized".
        const init = await agent.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "idlebiz", version: "1" },
          clientCapabilities: {},
        });

        const additionalDirectories = opts.addDirs ?? [];

        /**
         * Resume-first: an employee's session IS their working memory, so
         * starting fresh every run would begin each task with amnesia.
         * `session/resume` continues without replaying history, which is what
         * the wake-delta prompt assumes. A refusal falls through to a new
         * session and the caller clears the dead id.
         */
        const resumedId =
          opts.resumeSessionId !== undefined && init.agentCapabilities?.loadSession === true
            ? await agent
                .request("session/resume", {
                  sessionId: opts.resumeSessionId,
                  cwd: opts.cwd,
                  additionalDirectories,
                })
                .then(() => opts.resumeSessionId)
                .catch(() => undefined)
            : undefined;
        resumed = resumedId !== undefined;

        const startFresh = async (): Promise<string> => {
          const builder = agent.buildSession(opts.cwd);
          if (additionalDirectories.length > 0) {
            builder.withAdditionalDirectories(additionalDirectories);
          }
          return (await builder.start()).sessionId;
        };
        sessionId = resumedId ?? (await startFresh());

        // Every turn, not just fresh ones: a resumed session comes back in the
        // agent's default mode, and codex's default runs commands without ever
        // raising a permission request, so a mode set only at session creation
        // would leave later turns unsupervised.
        //
        // It throws rather than shrugging, because for an agent that only asks
        // in a particular mode, a swallowed failure here is indistinguishable
        // from a working gate.
        if (opts.agent.sessionModeId !== undefined) {
          await agent.request("session/set_mode", {
            sessionId,
            modeId: opts.agent.sessionModeId,
          });
        }

        // A resumed session already carries the instructions; sending them
        // again would re-pay for the whole system prompt every wake.
        const text =
          !resumed && opts.systemPrompt
            ? `${opts.systemPrompt}\n\n---\n\nYOUR TASK:\n\n${opts.prompt}`
            : opts.prompt;
        const res = await agent.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        flushMessage();
        // The turn's own totals are authoritative; the live cost above only
        // exists to stop a run mid-flight.
        const u = res.usage;
        if (u) {
          total = {
            inputTokens: (u.inputTokens ?? 0) + (u.cachedWriteTokens ?? 0),
            outputTokens: u.outputTokens ?? 0,
            cachedTokens: u.cachedReadTokens ?? 0,
            costUsd: billed,
          };
        }
        return res.stopReason;
      })
      .then((stopReason) => {
        const completed = stopReason === "end_turn" || stopReason === "max_tokens";
        settle(
          completed
            ? result({ kind: "completed" })
            : failed(stderrTail() || `agent stopped: ${stopReason}`),
        );
        return null;
      })
      .catch((cause: unknown) => settle(failed(errorMessage(cause))));
  });
}
