import { runNdjsonProcess } from "./ndjson-process";
import { arr, num, obj, str, type JsonObject } from "./json";
import { zeroUsage, type AgentUsage } from "./events";
import type { RunnerOptions, RunnerResult } from "./runner";

/**
 * Run a headless Codex session: `codex exec --json [resume <id>] -`, prompt
 * on stdin. Codex has no separate system-prompt channel, so on fresh sessions
 * the instructions are prepended to the prompt. Success requires a
 * `turn.completed` AND a clean exit. Codex reports tokens but never dollars —
 * usage.costUsd stays 0 and the caller prices it (see pricing.ts).
 */
/**
 * Codex takes hooks as a `-c` TOML override. Its shell tool is named `Bash`,
 * same as claude's, so one hook script serves both runners. Codex ignores a
 * JSON `permissionDecision` on stdout — only exit 2 with a stderr reason
 * blocks — which is why the hook signals denial that way.
 */
function codexHookConfig(command: string): string {
  const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `hooks.PreToolUse=[{matcher="^Bash$",hooks=[{type="command",command="${escaped}"}]}]`;
}

export function runCodex(opts: RunnerOptions): Promise<RunnerResult> {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    // Writes are confined to the workspace and --add-dir roots. Network stays
    // on: it is off by default under workspace-write, which would cut the
    // agent off from the control-plane API as well as the internet.
    "--sandbox",
    "workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=true",
  ];
  if (opts.permissionHookCommand) {
    args.push("-c", codexHookConfig(opts.permissionHookCommand));
  }
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
    onValue: (value, ctl) => {
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
          const delta = {
            inputTokens: num(u.input_tokens),
            outputTokens: num(u.output_tokens),
            cachedTokens: num(u.cached_input_tokens),
            costUsd: 0,
          };
          usage.inputTokens += delta.inputTokens;
          usage.outputTokens += delta.outputTokens;
          usage.cachedTokens += delta.cachedTokens;
          // Codex reports usage only here, so this lands at the end of the
          // turn — enough to stop sibling runs, too late to stop this one.
          ctl.recordUsage(delta);
          opts.onEvent({ type: "usage", usage: delta });
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
  item: JsonObject,
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
