import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RUNNER_IDS } from "@repo/domain/runners";
import type { RunnerId } from "@repo/domain/runners";
import { RUNNERS } from "./registry";
import type { Argv } from "./registry";

export const runnerBin = (id: RunnerId) => {
  const { command, override } = RUNNERS[id].cli;

  return process.env[override] ?? command;
};

export type RunnerProbe = { id: RunnerId; bin: string } & (
  | { installed: false }
  | { installed: true; version: string | null; authed: boolean }
);

export const isReady = (p: RunnerProbe) => p.installed && p.authed;

const PROBE_TIMEOUT_MS = 15_000;

/** `argv` as the caller starts a runner's CLI: itself, or inside whatever confines it. */
type CliLaunch = (id: RunnerId, argv: Argv) => Argv;

const execFileAsync = promisify(execFile);

const run = async ([bin, ...args]: Argv, env: Record<string, string>) => {
  try {
    const pending = execFileAsync(bin, args, {
      env,
      killSignal: "SIGKILL",
      timeout: PROBE_TIMEOUT_MS,
    });

    pending.child.stdin?.end();
    const { stderr, stdout } = await pending;

    return { ok: true, output: stdout + stderr };
  } catch {
    return { ok: false, output: "" };
  }
};

const probeRunner = async (id: RunnerId, env: Record<string, string>, launch: CliLaunch) => {
  const bin = runnerBin(id);
  const version = await run(launch(id, [bin, "--version"]), env);

  if (!version.ok) {
    return { bin, id, installed: false } satisfies RunnerProbe;
  }

  const { authProbe } = RUNNERS[id];
  const auth = await run(launch(id, [bin, ...authProbe.args]), env);

  return {
    authed: auth.ok && authProbe.loggedIn(auth.output),
    bin,
    id,
    installed: true,
    version: version.output.trim().split("\n")[0] ?? null,
  } satisfies RunnerProbe;
};

export const probeRunners = (envOf: (id: RunnerId) => Record<string, string>, launch: CliLaunch) =>
  Promise.all(RUNNER_IDS.map((id) => probeRunner(id, envOf(id), launch)));
