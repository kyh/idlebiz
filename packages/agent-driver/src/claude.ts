import { runNdjsonProcess } from "./ndjson-process";
import { arr, num, obj, str } from "./json";
import { zeroUsage, type AgentUsage } from "./events";
import type { RunnerOptions, RunnerResult } from "./runner";

/**
 * Run a headless Claude Code session: `claude --print --output-format
 * stream-json`, prompt on stdin. The terminal `result` event is the source
 * of truth for outcome, cost and session id — a bare exit without one is a
 * failure, never a silent success.
 */
export function runClaude(opts: RunnerOptions): Promise<RunnerResult> {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.resumeSessionId) {
    // Resumed sessions already carry the instructions — send only the wake prompt.
    args.push("--resume", opts.resumeSessionId);
  } else if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }
  if (opts.maxTurns && opts.maxTurns > 0) args.push("--max-turns", String(opts.maxTurns));
  for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);

  // `--dangerously-skip-permissions` refuses to run as root unless
  // IS_SANDBOX=1 marks the environment as already isolated. claude only
  // accepts the literal "1".
  const env: Record<string, string> = { ...opts.env };
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (isRoot && process.env.IS_SANDBOX !== "1") env.IS_SANDBOX = "1";

  return runNdjsonProcess({
    bin: opts.bin,
    args,
    cwd: opts.cwd,
    stdinText: opts.prompt,
    env,
    signal: opts.signal,
    idleTimeoutMs: opts.idleTimeoutMs,
    maxSessionMs: opts.maxSessionMs,
    onValue: (value, ctl) => {
      const e = obj(value);
      switch (str(e.type)) {
        case "assistant": {
          for (const block of arr(obj(e.message).content)) {
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
function extractUsage(resultEvent: Record<string, unknown>): AgentUsage {
  const u = obj(resultEvent.usage);
  return {
    inputTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens),
    outputTokens: num(u.output_tokens),
    cachedTokens: num(u.cache_read_input_tokens),
    costUsd: num(resultEvent.total_cost_usd),
  };
}
