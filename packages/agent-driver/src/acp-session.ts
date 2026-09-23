import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { zeroUsage } from "./events";
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

// Claude's cost extension reports this process's running total, including on resume.
const RunCost = z.object({ cost: z.object({ amount: z.number() }) });

/** The agent's own account of a tool call, as the policy layer needs it. */
const ToolCallDescription = z.object({ description: z.string().optional() });

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
  /** Session mode to select once the session exists — see `RunnerAdapter`. */
  sessionModeId?: string;
  /** Environment this agent needs to find its own CLI. */
  env?: Record<string, string>;
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

// Even once the leader is gone: codex-acp dies on SIGTERM without stopping its app-server,
// and a group's id cannot be reused while any member of it lives.
const killGroup = (child: ChildProcess): void => {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* group already gone */
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
        env: { ...process.env, ...opts.agent.env, ...opts.env },
        signal: opts.signal,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      settle(failed(`failed to spawn ${bin}: ${errorMessage(error)}`));
      return;
    }

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
            meta: ctx.params._meta,
            rawInput: toolCall.rawInput,
            title: toolCall.title ?? toolTitles.get(toolCall.toolCallId),
          }),
        };
        const decision = opts.onPermission
          ? await opts.onPermission(request, ended.signal)
          : { allow: true };
        // Match protocol kinds, not adapter-specific ids. Prefer one-command approval.
        const pick = (kind: string): string | undefined =>
          ctx.params.options.find((o) => o.kind === kind)?.optionId;
        const optionId = decision.allow
          ? (pick("allow_once") ?? pick("allow_always"))
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
            args: update.rawInput,
            kind: update.kind ?? undefined,
            toolName: update.title || update.kind || "tool",
            type: "tool_start",
          });
          return;
        }
        const cost = RunCost.safeParse(update);
        if (cost.success && cost.data.cost.amount > total.costUsd) {
          total = { ...total, costUsd: cost.data.cost.amount };
        }
      });

    const stream = ndJsonStream(webWritable(stdin), webReadable(stdout));
    const turn = async (): Promise<void> => {
      const stopReason = await app.connectWith(stream, async (agent) => {
        // Required before anything else. claude's adapter tolerates its
        // absence; codex's answers every later call with "Not initialized".
        const init = await agent.request("initialize", {
          clientCapabilities: {},
          clientInfo: { name: "idlebiz", version: "1" },
          protocolVersion: PROTOCOL_VERSION,
        });

        const additionalDirectories = opts.addDirs ?? [];

        // Resume without replaying history; a rejected session id falls back to fresh.
        const resume = async (): Promise<string | undefined> => {
          if (opts.resumeSessionId === undefined || init.agentCapabilities?.loadSession !== true) {
            return undefined;
          }
          try {
            await agent.request("session/resume", {
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
          const builder = agent.buildSession(opts.cwd);
          if (additionalDirectories.length > 0) {
            builder.withAdditionalDirectories(additionalDirectories);
          }
          const started = await builder.start();
          return started.sessionId;
        };
        sessionId = resumedId ?? (await startFresh());

        // Resume restores the default mode. Set it every turn and fail if it cannot be
        // set: Codex's default can execute without raising permission requests.
        if (opts.agent.sessionModeId !== undefined) {
          await agent.request("session/set_mode", {
            modeId: opts.agent.sessionModeId,
            sessionId,
          });
        }

        const text =
          !resumed && opts.systemPrompt
            ? `${opts.systemPrompt}\n\n---\n\nYOUR TASK:\n\n${opts.prompt}`
            : opts.prompt;
        const res = await agent.request("session/prompt", {
          prompt: [{ text, type: "text" }],
          sessionId,
        });
        flushMessage();
        // the turn's own token totals are authoritative; the cost is what the agent reported above
        const u = res.usage;
        if (u) {
          total = {
            cachedTokens: u.cachedReadTokens ?? 0,
            costUsd: total.costUsd,
            inputTokens: (u.inputTokens ?? 0) + (u.cachedWriteTokens ?? 0),
            outputTokens: u.outputTokens ?? 0,
          };
        }
        return res.stopReason;
      });
      const completed = stopReason === "end_turn" || stopReason === "max_tokens";
      settle(
        completed
          ? result({ kind: "completed" })
          : failed(stderrTail() || `agent stopped: ${stopReason}`),
      );
    };
    void (async () => {
      try {
        await turn();
      } catch (error) {
        settle(failed(errorMessage(error)));
      }
    })();
  });
