import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { zeroUsage, type AgentUsage } from "./events";
import type { PermissionRequest, RunnerOptions, RunnerResult } from "./runner";

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
 * Token counts, wherever they appear. ACP leaves usage to the agent, so these
 * ride in as loosely-typed extras on both the turn result and the live update;
 * every field is optional and absent means unknown, never zero.
 */
const AgentTokenCounts = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cachedReadTokens: z.number().optional(),
    cachedWriteTokens: z.number().optional(),
  })
  .loose();
type AgentTokenCounts = z.infer<typeof AgentTokenCounts>;

/** The agent's own account of a tool call, as the policy layer needs it. */
const ToolCallInput = z
  .object({ command: z.string().optional(), description: z.string().optional() })
  .loose();

export interface AcpAgentSpec {
  /** Argv of the ACP agent to spawn (e.g. the claude or codex adapter). */
  command: readonly string[];
  /**
   * Session mode to select once the session exists, when the agent offers one.
   *
   * Load-bearing for the founder gate: codex defaults to a mode that runs
   * commands without asking, so nothing would ever reach the permission
   * handler. Choosing a mode that requires approval is what turns the gate on,
   * and a wrong value here disables it silently.
   */
  sessionModeId?: string;
}

/** Node stream → web stream, written out rather than asserted across the skew. */
function webReadable(stream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // `end` and `error` can both fire, and closing a controller twice throws
      // — which surfaces as an unhandled crash during teardown rather than as
      // the run failure that actually happened.
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

/** Cache creation is billed as input; cache reads are counted separately. */
function toUsage(counts: AgentTokenCounts): AgentUsage {
  return {
    inputTokens: (counts.inputTokens ?? 0) + (counts.cachedWriteTokens ?? 0),
    outputTokens: counts.outputTokens ?? 0,
    cachedTokens: counts.cachedReadTokens ?? 0,
    costUsd: 0,
  };
}

export function runAcpTurn(opts: RunnerOptions, spec: AcpAgentSpec): Promise<RunnerResult> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess | undefined;
    let settled = false;
    let stderrTail = "";
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionId: string | undefined;
    let lastMessage = "";
    let total = zeroUsage();

    const settle = (res: RunnerResult): void => {
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
    const failure = (error: string): RunnerResult => ({
      ok: false,
      summary: lastMessage.trim(),
      sessionId,
      usage: { ...total },
      error,
    });

    const pokeIdle = (): void => {
      if (opts.idleTimeoutMs <= 0 || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        settle(failure(`no output for ${fmtMs(opts.idleTimeoutMs)} — treating the agent as hung`));
      }, opts.idleTimeoutMs);
      idleTimer.unref?.();
    };

    const [bin, ...args] = spec.command;
    if (bin === undefined) {
      settle(failure("no ACP agent command configured"));
      return;
    }

    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ["pipe", "pipe", "pipe"],
        signal: opts.signal,
      });
    } catch (err) {
      settle(
        failure(`failed to spawn ${bin}: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }

    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) {
      settle(failure(`${bin}: stdio pipes unavailable`));
      return;
    }
    // The agent keeps writing for a moment after we kill it; that EPIPE is
    // expected teardown noise, not a run failure.
    stdin.on("error", () => {});
    stdout.on("error", () => {});
    stderr.on("data", (d: Buffer) => {
      pokeIdle();
      stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_MAX);
    });
    child.on("error", (err: Error) => settle(failure(`${bin}: ${err.message}`)));
    child.on("close", (code) =>
      settle(failure(stderrTail.trim() || `${bin} exited with code ${code} mid-turn`)),
    );

    pokeIdle();
    if (opts.maxSessionMs > 0) {
      sessionTimer = setTimeout(() => {
        settle(failure(`exceeded the ${fmtMs(opts.maxSessionMs)} session limit — killed`));
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
        const decision = opts.onPermission
          ? await opts.onPermission(request)
          : { allow: true as const };
        // Option ids are agent-specific ("allow" vs "allow_once", "reject" vs
        // "reject_once"), so match by prefix rather than one vocabulary.
        const pick = (want: string): string | undefined =>
          ctx.params.options.find((o) => o.optionId.startsWith(want))?.optionId;
        const optionId = decision.allow
          ? (pick("allow") ?? pick("accept"))
          : (pick("reject") ?? pick("deny"));
        if (optionId === undefined) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId } };
      })
      .onNotification("session/update", (ctx) => {
        pokeIdle();
        const update = ctx.params.update;
        if (update.sessionUpdate === "agent_message_chunk") {
          if (update.content.type === "text") lastMessage += update.content.text;
          return;
        }
        if (update.sessionUpdate === "tool_call") {
          opts.onEvent({
            type: "tool_start",
            toolName: update.kind ?? "tool",
            args: update.rawInput,
          });
          return;
        }
        // Usage rides in as an agent extension, so it is read by shape rather
        // than by the protocol's own union. It is a running total; the
        // scheduler's budget wants deltas.
        const counts = AgentTokenCounts.safeParse(update);
        if (!counts.success) return;
        const running = toUsage(counts.data);
        if (running.inputTokens + running.outputTokens === 0) return;
        const delta: AgentUsage = {
          inputTokens: Math.max(0, running.inputTokens - total.inputTokens),
          outputTokens: Math.max(0, running.outputTokens - total.outputTokens),
          cachedTokens: Math.max(0, running.cachedTokens - total.cachedTokens),
          costUsd: 0,
        };
        total = running;
        if (delta.inputTokens + delta.outputTokens > 0) {
          opts.onEvent({ type: "usage", usage: delta });
        }
      });

    const stream = ndJsonStream(webWritable(stdin), webReadable(stdout));
    void app
      .connectWith(stream, async (agent) => {
        // Required before anything else. claude's adapter tolerates its
        // absence; codex's answers every later call with "Not initialized".
        await agent.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "idlebiz", version: "1" },
          clientCapabilities: {},
        });
        const builder = agent.buildSession(opts.cwd);
        const extra = opts.addDirs ?? [];
        if (extra.length > 0) builder.withAdditionalDirectories([...extra]);
        const session = await builder.start();
        sessionId = session.sessionId;
        if (spec.sessionModeId !== undefined) {
          // Best effort: an agent that offers no modes still runs, it just
          // keeps whatever default it shipped with.
          await agent
            .request("session/set_mode", { sessionId, modeId: spec.sessionModeId })
            .catch(() => undefined);
        }
        const prompt = opts.systemPrompt
          ? `${opts.systemPrompt}\n\n---\n\nYOUR TASK:\n\n${opts.prompt}`
          : opts.prompt;
        const res = await session.prompt(prompt);
        const counts = AgentTokenCounts.safeParse(res.usage);
        if (counts.success) {
          const final = toUsage(counts.data);
          if (final.inputTokens + final.outputTokens > 0) total = final;
        }
        return res.stopReason;
      })
      .then((stopReason) => {
        const ok = stopReason === "end_turn" || stopReason === "max_tokens";
        settle({
          ok,
          summary: lastMessage.trim(),
          sessionId,
          usage: { ...total },
          error: ok ? undefined : stderrTail.trim() || `agent stopped: ${stopReason}`,
        });
        return null;
      })
      .catch((cause: unknown) =>
        settle(failure(cause instanceof Error ? cause.message : String(cause))),
      );
  });
}
