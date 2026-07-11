import { spawn } from "node:child_process";
import { obj } from "./json";
import { runnerBin, RUNNER_IDS, type RunnerId } from "./runner";

// Preflight probes: which coding-agent CLIs exist on this machine and whether
// they're signed in. Fully async — probes must never block the main process
// (boot runs them before the window shows; onboarding re-runs them mid-flow).

export interface RunnerProbe {
  id: RunnerId;
  bin: string;
  installed: boolean;
  version: string | null;
  authed: boolean;
}

const PROBE_TIMEOUT_MS = 15_000;

function run(bin: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ ok, output });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done(false);
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    const collect = (d: Buffer): void => {
      output += d.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", () => done(false));
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

/** `claude auth status` prints JSON with a loggedIn flag. */
async function claudeAuthed(bin: string): Promise<boolean> {
  const r = await run(bin, ["auth", "status"]);
  if (!r.ok) return false;
  try {
    const start = r.output.indexOf("{");
    if (start < 0) return false;
    const parsed: unknown = JSON.parse(r.output.slice(start, r.output.lastIndexOf("}") + 1));
    return obj(parsed).loggedIn === true;
  } catch {
    return false;
  }
}

/** `codex login status` exits 0 and says how you're logged in. */
async function codexAuthed(bin: string): Promise<boolean> {
  const r = await run(bin, ["login", "status"]);
  return r.ok && !/not logged in/i.test(r.output);
}

async function probeRunner(id: RunnerId): Promise<RunnerProbe> {
  const bin = runnerBin(id);
  const version = await run(bin, ["--version"]);
  if (!version.ok) return { id, bin, installed: false, version: null, authed: false };
  return {
    id,
    bin,
    installed: true,
    version: version.output.trim().split("\n")[0] ?? null,
    authed: id === "claude" ? await claudeAuthed(bin) : await codexAuthed(bin),
  };
}

/** Probe every runner concurrently (version + auth within a runner are sequential). */
export function probeRunners(): Promise<RunnerProbe[]> {
  return Promise.all(RUNNER_IDS.map((id) => probeRunner(id)));
}
