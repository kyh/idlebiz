// The PreToolUse hook both CLIs run before every shell command.
//
// This runs standalone inside the agent's own process tree, so it cannot
// import from this repo — it is written to disk at boot and executed by `node`.
// It lives as a real file rather than a string constant so it is typechecked,
// linted and formatted like everything else: a syntax error here would take the
// gate with it.
//
// Contract, verified against claude 2.1.238 and codex-cli 0.149.0:
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

/** Defer: claude falls through to its own classifier, codex permits. */
const defer = () => process.exit(0);

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
  defer(); // nothing parseable to gate
}
if (!command) defer();

// Fail CLOSED when the game cannot be reached.
//
// The tempting default is the opposite — don't wedge the agent over a network
// blip. But this is loopback to the process that spawned us: unreachable means
// the app is gone, so the run is already orphaned and should stop rather than
// keep working unsupervised with the founder's credentials. It also means the
// gate cannot quietly cease to exist after a port change or a bad refactor and
// go unnoticed, which is the failure mode that actually bites.
//
// Denials are self-limiting: the agent is told why, finishes early, and the
// run's own watchdogs settle it.
const unreachable =
  "IdleBiz is not reachable, so nothing can be approved right now. Stop and report that the office is offline.";

if (!apiUrl || !token) deny(unreachable);

try {
  const res = await fetch(apiUrl + "/v1/permission", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
  });
  if (!res.ok) deny(unreachable);
  const body = await res.json();
  if (body?.decision === "deny") deny(body.reason ?? "The founder has not approved this action.");
  defer();
} catch {
  deny(unreachable);
}
