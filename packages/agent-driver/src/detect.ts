import { spawn } from "node:child_process";
import { RUNNERS } from "./registry";
import { RUNNER_IDS, type RunnerId } from "./runner";

// Probe the player's CLI login, which the ACP adapter inherits.
export const runnerBin = (id: RunnerId): string =>
  id === "claude" ? (process.env.CLAUDE_BIN ?? "claude") : (process.env.CODEX_BIN ?? "codex");

export type RunnerProbe = { id: RunnerId; bin: string } & (
  | { installed: false }
  | { installed: true; version: string | null; authed: boolean }
);

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

export function probeRunners(): Promise<RunnerProbe[]> {
  return Promise.all(RUNNER_IDS.map(probeRunner));
}
