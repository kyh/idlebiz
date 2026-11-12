import { spawnSync } from "node:child_process";

/** The words bash makes of `line`, by having it print each: what a shell really hands a program. */
export const shellWords = (line: string): string[] => {
  const { status, stdout } = spawnSync("/bin/bash", ["-c", `printf '%s\\0' ${line}`], {
    encoding: "utf-8",
  });
  if (status !== 0) {
    throw new Error(`bash could not read ${line}`);
  }
  return stdout.split("\0").slice(0, -1);
};
