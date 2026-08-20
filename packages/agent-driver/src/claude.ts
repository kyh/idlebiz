import { runNdjsonProcess } from "./ndjson-process";
import { arr, num, obj, str, type JsonObject } from "./json";
import { zeroUsage, type AgentUsage } from "./events";
import type { RunnerOptions, RunnerResult } from "./runner";

/**
 * Run a headless Claude Code session: `claude --print --output-format
 * stream-json`, prompt on stdin. The terminal `result` event is the source
 * of truth for outcome, cost and session id — a bare exit without one is a
 * failure, never a silent success.
 */
/** `--settings` accepts inline JSON, so the hook needs no file on disk. */
function hookSettings(command: string): JsonObject {
  return {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }],
    },
  };
}

export function runClaude(opts: RunnerOptions): Promise<RunnerResult> {
  // auto, not bypass: the classifier is the general safety net, and the
  // permission hook below is the game's own founder-approval gate. A hook that
  // returns no decision falls through to the classifier.
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "auto",
  ];
  if (opts.permissionHookCommand) {
    args.push("--settings", JSON.stringify(hookSettings(opts.permissionHookCommand)));
  }
  if (opts.model) args.push("--model", opts.model);
  if (opts.resumeSessionId) {
    // Resumed sessions already carry the instructions — send only the wake prompt.
    args.push("--resume", opts.resumeSessionId);
  } else if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }
  if (opts.maxTurns && opts.maxTurns > 0) args.push("--max-turns", String(opts.maxTurns));
  for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);

  const billedMessages = new Set<string>();

  return runNdjsonProcess({
    bin: opts.bin,
    args,
    cwd: opts.cwd,
    stdinText: opts.prompt,
    env: opts.env,
    signal: opts.signal,
    idleTimeoutMs: opts.idleTimeoutMs,
    maxSessionMs: opts.maxSessionMs,
    onValue: (value, ctl) => {
      const e = obj(value);
      switch (str(e.type)) {
        case "assistant": {
          // One message can arrive as several assistant events (one per
          // content block), so bill it once — summing every event overstates
          // the run and would trip a budget stop early.
          const message = obj(e.message);
          const id = str(message.id);
          if (id !== undefined && !billedMessages.has(id)) {
            billedMessages.add(id);
            opts.onEvent({ type: "usage", usage: extractUsage(message) });
          }
          for (const block of arr(message.content)) {
            const b = obj(block);
            if (b.type === "text") {
              const text = str(b.text) ?? "";
              if (text.trim()) opts.onEvent({ type: "message_end", role: "assistant", text });
            } else if (b.type === "tool_use") {
              opts.onEvent({
                type: "tool_start",
                toolName: str(b.name) ?? "tool",
                args: b.input,
              });
            }
          }
          return;
        }
        case "result": {
          const isError = e.is_error === true || str(e.subtype) !== "success";
          const resultText = str(e.result) ?? "";
          ctl.finish({
            ok: !isError,
            summary: resultText,
            sessionId: str(e.session_id),
            usage: extractUsage(e),
            error: isError ? resultText || "claude reported an error" : undefined,
          });
          return;
        }
        default:
          return;
      }
    },
    onExit: (code, stderrTail) => ({
      ok: false,
      summary: "",
      usage: zeroUsage(),
      error: stderrTail || `claude exited with code ${code} without a result event`,
    }),
  });
}

/** The result event's usage block; cache creation is billed input. */
function extractUsage(resultEvent: JsonObject): AgentUsage {
  const u = obj(resultEvent.usage);
  return {
    inputTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens),
    outputTokens: num(u.output_tokens),
    cachedTokens: num(u.cache_read_input_tokens),
    costUsd: num(resultEvent.total_cost_usd),
  };
}
