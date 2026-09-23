import { spawn } from "node:child_process";
import { RUNNERS } from "./registry";
import { RUNNER_IDS } from "./runner";
import type { RunnerId } from "./runner";

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

const run = (bin: string, args: string[]): Promise<{ ok: boolean; output: string }> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps a callback API (child process events)
  new Promise((resolve) => {
    let output = "";
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) {
        return;
      }
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

// Probe the player's CLI login, which the ACP adapter inherits.
const probeRunner = async (id: RunnerId): Promise<RunnerProbe> => {
  const bin = runnerBin(id);
  const version = await run(bin, ["--version"]);
  if (!version.ok) {
    return { bin, id, installed: false };
  }
  const { authProbe } = RUNNERS[id];
  const auth = await run(bin, authProbe.args);
  return {
    authed: auth.ok && authProbe.loggedIn(auth.output),
    bin,
    id,
    installed: true,
    version: version.output.trim().split("\n")[0] ?? null,
  };
};

export const probeRunners = (): Promise<RunnerProbe[]> => Promise.all(RUNNER_IDS.map(probeRunner));
