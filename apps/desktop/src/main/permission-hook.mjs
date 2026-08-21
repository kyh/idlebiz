// The PreToolUse hook both CLIs run before every shell command.
//
// This runs standalone inside the agent's own process tree, so it cannot
// import from this repo — it is written to disk at boot and executed by `node`.
// It lives as a real file rather than a string constant so it is typechecked,
// linted and formatted like everything else: it fails OPEN by design, which
// means a syntax error here is a silently disabled security gate.
//
// Contract, verified against claude 2.1.235 and codex-cli 0.144.1:
//  - both deliver the same JSON on stdin, with tool_input.command
//  - exit 2 with a reason on stderr blocks the call in BOTH
//  - codex ignores a JSON permissionDecision on stdout; claude honours it
//  - exit 0 with no output defers (claude falls through to its classifier)
//  - codex does NOT pass the parent env to hooks, so the API url and token
//    arrive as argv instead

import { readFileSync } from "node:fs";

/** Loopback, on the same machine: if it has not answered by now, it will not. */
const HOOK_TIMEOUT_MS = 2000;

const [apiUrl, token] = process.argv.slice(2);

// Fail open: a hook that cannot reach the game must not wedge every shell
// command. Claude still has its own classifier underneath this.
const allow = () => process.exit(0);

const deny = (reason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.stderr.write(reason);
  process.exit(2);
};

let command = "";
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  command = input?.tool_input?.command ?? "";
} catch {
  allow();
}
if (!command || !apiUrl || !token) allow();

try {
  const res = await fetch(apiUrl + "/v1/permission", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
  });
  if (!res.ok) allow();
  const body = await res.json();
  if (body?.decision === "deny") deny(body.reason ?? "The founder has not approved this action.");
  allow();
} catch {
  allow();
}
