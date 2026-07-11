import { spawnSync } from "node:child_process";
import { runnerBin, RUNNER_IDS, type RunnerId } from "./runner";

// Preflight probes: which coding-agent CLIs exist on this machine and whether
// they're signed in. Probes shell out synchronously (boot-time only).

export interface RunnerProbe {
  id: RunnerId;
  bin: string;
  installed: boolean;
  version: string | null;
  authed: boolean;
}

const PROBE_TIMEOUT_MS = 15_000;

function run(bin: string, args: string[]): { ok: boolean; output: string } {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
  return { ok: !r.error && r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** `claude auth status` prints JSON with a loggedIn flag. */
function claudeAuthed(bin: string): boolean {
  const r = run(bin, ["auth", "status"]);
  if (!r.ok) return false;
  try {
    const start = r.output.indexOf("{");
    if (start < 0) return false;
    const parsed: unknown = JSON.parse(r.output.slice(start, r.output.lastIndexOf("}") + 1));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).loggedIn === true
    );
  } catch {
    return false;
  }
}

/** `codex login status` exits 0 and says how you're logged in. */
function codexAuthed(bin: string): boolean {
  const r = run(bin, ["login", "status"]);
  return r.ok && !/not logged in/i.test(r.output);
}

export function probeRunner(id: RunnerId): RunnerProbe {
  const bin = runnerBin(id);
  const version = run(bin, ["--version"]);
  if (!version.ok) return { id, bin, installed: false, version: null, authed: false };
  return {
    id,
    bin,
    installed: true,
    version: version.output.trim().split("\n")[0] ?? null,
    authed: id === "claude" ? claudeAuthed(bin) : codexAuthed(bin),
  };
}

export function probeRunners(): RunnerProbe[] {
  return RUNNER_IDS.map((id) => probeRunner(id));
}
