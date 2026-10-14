import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RUNNER_IDS } from "@repo/domain/runners";
import type { RunnerId } from "@repo/domain/runners";
import { RUNNERS } from "./registry";

export const runnerBin = (id: RunnerId): string => {
  const { command, override } = RUNNERS[id].cli;
  return process.env[override] ?? command;
};

export type RunnerProbe = { id: RunnerId; bin: string } & (
  | { installed: false }
  | { installed: true; version: string | null; authed: boolean }
);

export const isReady = (p: RunnerProbe): boolean => p.installed && p.authed;

const PROBE_TIMEOUT_MS = 15_000;

/** `argv` as the caller starts a runner's CLI: itself, or inside whatever confines it. */
type CliLaunch = (id: RunnerId, argv: readonly string[]) => readonly string[];

const execFileAsync = promisify(execFile);

/** Whether `argv` exited 0 within the probe's time, and what it printed then. */
const run = async (
  [bin = "", ...args]: readonly string[],
  env: Record<string, string>,
): Promise<{ ok: boolean; output: string }> => {
  try {
    const pending = execFileAsync(bin, args, {
      env,
      killSignal: "SIGKILL",
      timeout: PROBE_TIMEOUT_MS,
    });
    // execFile pipes stdin, and a CLI that reads a piped stdin as its prompt would wait out the
    // timeout on it
    pending.child.stdin?.end();
    const { stderr, stdout } = await pending;
    return { ok: true, output: stdout + stderr };
  } catch {
    return { ok: false, output: "" };
  }
};

// Probe the player's CLI login as its runs start it, so signed in means a run can sign in.
const probeRunner = async (
  id: RunnerId,
  env: Record<string, string>,
  launch: CliLaunch,
): Promise<RunnerProbe> => {
  const bin = runnerBin(id);
  const version = await run(launch(id, [bin, "--version"]), env);
  if (!version.ok) {
    return { bin, id, installed: false };
  }
  const { authProbe } = RUNNERS[id];
  const auth = await run(launch(id, [bin, ...authProbe.args]), env);
  return {
    authed: auth.ok && authProbe.loggedIn(auth.output),
    bin,
    id,
    installed: true,
    version: version.output.trim().split("\n")[0] ?? null,
  };
};

export const probeRunners = (
  envOf: (id: RunnerId) => Record<string, string>,
  launch: CliLaunch,
): Promise<RunnerProbe[]> =>
  Promise.all(RUNNER_IDS.map((id) => probeRunner(id, envOf(id), launch)));
