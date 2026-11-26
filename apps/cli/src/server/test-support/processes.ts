import { readFileSync } from "node:fs";

const stateOf = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf-8");

    return stat.slice(stat.lastIndexOf(")") + 2).split(" ", 1)[0] ?? null;
  } catch {
    return null;
  }
};

/**
 * Whether `pid` still runs. A process that has exited but that nobody has reaped yet still
 * answers a signal: one a killed parent left to a PID 1 that reaps nothing, as in a container,
 * stays so. Linux names that state in /proc (Z, or X once it is going); macOS's launchd reaps.
 */
export const running = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  const state = stateOf(pid);

  return state !== "Z" && state !== "X";
};
