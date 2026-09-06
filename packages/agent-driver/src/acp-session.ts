import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { zeroUsage, type AgentEvent, type AgentUsage } from "./events";

// One ACP turn. Owns subprocess teardown, watchdogs and usage accounting;
// adapters own the CLI wire formats.

/** Keep only the tail of stderr — used solely for final error reporting. */
const STDERR_TAIL_MAX = 16_000;

/** Human-friendly duration for watchdog messages ("45m", "3s"). */
const fmtMs = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;

// Claude's cost extension reports this process's running total, including on resume.
const RunCost = z.object({ cost: z.object({ amount: z.number() }) });

/** The agent's own account of a tool call, as the policy layer needs it. */
const ToolCallInput = z.object({
  command: z.string().optional(),
  description: z.string().optional(),
});

// Readable.toWeb's Node types conflict with the DOM stream types in the desktop build.
function webReadable(stream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Both events can fire; closing twice would mask the original failure.
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
  /** AGENTS.md instructions, sent only for fresh sessions to avoid paying for them twice. */
  systemPrompt: string;
  /** Working directory — the company workspace where real work lands. */
  cwd: string;
  /** Continue this session instead of starting fresh (the employee's memory). */
  resumeSessionId?: string;
  /** Extra dirs the agent may read/write (e.g. its own agent package dir). */
  addDirs?: string[];
  /** Run-scoped env additions (control-plane URL + token, secrets). */
  env?: Record<string, string>;
  /** Decides tool permissions. Omission allows everything; the caller must provide confinement. */
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
    let total = zeroUsage();

    // ACP has no message-end marker. Flush prose before a tool call or at turn end.
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
      // Orphaned grandchildren can keep pipes open after their parent dies.
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
        // Match protocol kinds, not adapter-specific ids. Prefer one-command approval.
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
          flushMessage();
          opts.onEvent({
            type: "tool_start",
            toolName: update.title || update.kind || "tool",
            kind: update.kind ?? undefined,
            args: update.rawInput,
          });
          return;
        }
        const cost = RunCost.safeParse(update);
        if (cost.success && cost.data.cost.amount > total.costUsd) {
          total = { ...total, costUsd: cost.data.cost.amount };
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

        // Resume without replaying history; a rejected session id falls back to fresh.
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

        // Resume restores the default mode. Set it every turn and fail if it cannot be
        // set: Codex's default can execute without raising permission requests.
        if (opts.agent.sessionModeId !== undefined) {
          await agent.request("session/set_mode", {
            sessionId,
            modeId: opts.agent.sessionModeId,
          });
        }

        const text =
          !resumed && opts.systemPrompt
            ? `${opts.systemPrompt}\n\n---\n\nYOUR TASK:\n\n${opts.prompt}`
            : opts.prompt;
        const res = await agent.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        flushMessage();
        // the turn's own token totals are authoritative; the cost is what the agent reported above
        const u = res.usage;
        if (u) {
          total = {
            inputTokens: (u.inputTokens ?? 0) + (u.cachedWriteTokens ?? 0),
            outputTokens: u.outputTokens ?? 0,
            cachedTokens: u.cachedReadTokens ?? 0,
            costUsd: total.costUsd,
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
