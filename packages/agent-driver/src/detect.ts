import { spawn } from "node:child_process";
import { RUNNERS } from "./registry";
import { RUNNER_IDS, type RunnerId } from "./runner";

// Preflight probes: which coding-agent CLIs exist on this machine and whether
// they're signed in. Fully async — probes must never block the main process
// (boot runs them before the window shows; onboarding re-runs them mid-flow).

/**
 * The underlying CLI binary, with the same override hooks the CLIs use.
 *
 * We spawn ACP adapters rather than these directly, but the adapters run on
 * the CLI's own login — so this is still what gets probed to answer "can this
 * runner work at all".
 */
export const runnerBin = (id: RunnerId): string =>
  id === "claude" ? (process.env.CLAUDE_BIN ?? "claude") : (process.env.CODEX_BIN ?? "codex");

/** What the machine has: nothing at `bin`, or a CLI that is or is not signed in. */
export type RunnerProbe = { id: RunnerId; bin: string } & (
  | { installed: false }
  | { installed: true; version: string | null; authed: boolean }
);

/** A runner work can run on right now. */
export const isReady = (p: RunnerProbe): boolean => p.installed && p.authed;

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

async function probeRunner(id: RunnerId): Promise<RunnerProbe> {
  const bin = runnerBin(id);
  const version = await run(bin, ["--version"]);
  if (!version.ok) return { id, bin, installed: false };
  const { authProbe } = RUNNERS[id];
  const auth = await run(bin, authProbe.args);
  return {
    id,
    bin,
    installed: true,
    version: version.output.trim().split("\n")[0] ?? null,
    authed: auth.ok && authProbe.loggedIn(auth.output),
  };
}

/** Probe every runner concurrently (version + auth within a runner are sequential). */
export function probeRunners(): Promise<RunnerProbe[]> {
  return Promise.all(RUNNER_IDS.map((id) => probeRunner(id)));
}
