import { runNdjsonProcess } from "./ndjson-process";
import { arr, num, obj, str } from "./json";
import { zeroUsage, type AgentUsage } from "./events";
import type { RunnerOptions, RunnerResult } from "./runner";

/**
 * Run a headless Codex session: `codex exec --json [resume <id>] -`, prompt
 * on stdin. Codex has no separate system-prompt channel, so on fresh sessions
 * the instructions are prepended to the prompt. Success requires a
 * `turn.completed` AND a clean exit. Codex reports tokens but never dollars —
 * usage.costUsd stays 0 and the caller prices it (see pricing.ts).
 */
export function runCodex(opts: RunnerOptions): Promise<RunnerResult> {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    // Full autonomy, matching the trust level agents already had: they need
    // network (deploys, the game's control-plane API) and workspace writes.
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  if (opts.model) args.push("--model", opts.model);
  for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);
  if (opts.resumeSessionId) args.push("resume", opts.resumeSessionId);
  args.push("-"); // read the prompt from stdin

  // Resumed sessions already carry the instructions — send only the wake prompt.
  const stdinText =
    opts.resumeSessionId || !opts.systemPrompt
      ? opts.prompt
      : `${opts.systemPrompt}\n\n---\n\nYOUR TASK:\n\n${opts.prompt}`;

  let sessionId: string | undefined;
  let lastMessage = "";
  let turnCompleted = false;
  let failure: string | undefined;
  const usage: AgentUsage = zeroUsage();

  return runNdjsonProcess({
    bin: opts.bin,
    args,
    cwd: opts.cwd,
    stdinText,
    env: opts.env,
    signal: opts.signal,
    idleTimeoutMs: opts.idleTimeoutMs,
    maxSessionMs: opts.maxSessionMs,
    onValue: (value) => {
      const e = obj(value);
      switch (str(e.type)) {
        case "thread.started": {
          sessionId = str(e.thread_id);
          return;
        }
        case "item.started":
        case "item.completed": {
          onItem(opts, obj(e.item), str(e.type) === "item.started", (text) => {
            lastMessage = text;
          });
          return;
        }
        case "turn.completed": {
          turnCompleted = true;
          const u = obj(e.usage);
          usage.inputTokens += num(u.input_tokens);
          usage.outputTokens += num(u.output_tokens);
          usage.cachedTokens += num(u.cached_input_tokens);
          return;
        }
        case "turn.failed": {
          failure = str(obj(e.error).message) ?? "codex turn failed";
          return;
        }
        case "error": {
          failure = str(e.message) ?? failure;
          return;
        }
        default:
          return;
      }
    },
    onExit: (code, stderrTail) => {
      const ok = code === 0 && turnCompleted && !failure;
      return {
        ok,
        summary: lastMessage,
        sessionId,
        usage,
        error: ok
          ? undefined
          : (failure ?? (stderrTail || `codex exited with code ${code} without completing a turn`)),
      };
    },
  });
}

/** Map a codex thread item onto AgentEvents. Tool-ish items report once when
 * they start (so the feed shows live work); messages once when they complete. */
function onItem(
  opts: RunnerOptions,
  item: Record<string, unknown>,
  started: boolean,
  onMessage: (text: string) => void,
): void {
  switch (str(item.item_type) ?? str(item.type)) {
    case "agent_message": {
      const text = str(item.text) ?? "";
      if (!started && text.trim()) {
        onMessage(text);
        opts.onEvent({ type: "message_end", role: "assistant", text });
      }
      return;
    }
    case "command_execution": {
      if (started) {
        opts.onEvent({
          type: "tool_start",
          toolName: "shell",
          args: { command: str(item.command) ?? "" },
        });
      }
      return;
    }
    case "file_change": {
      if (started) return;
      const paths = arr(item.changes)
        .map((c) => str(obj(c).path))
        .filter((p): p is string => Boolean(p));
      opts.onEvent({ type: "tool_start", toolName: "edit", args: { paths } });
      return;
    }
    case "mcp_tool_call": {
      if (!started) return;
      const name = [str(item.server), str(item.tool)].filter(Boolean).join(".") || "mcp";
      opts.onEvent({ type: "tool_start", toolName: name, args: {} });
      return;
    }
    case "web_search": {
      if (!started) return;
      opts.onEvent({
        type: "tool_start",
        toolName: "web_search",
        args: { query: str(item.query) ?? "" },
      });
      return;
    }
    case "error": {
      const message = str(item.message);
      if (!started && message) {
        opts.onEvent({ type: "message_end", role: "assistant", text: `⚠ ${message}` });
      }
      return;
    }
    default:
      return;
  }
}
