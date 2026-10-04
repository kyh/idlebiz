import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";

// A copy in a scratch checkout, so its patterns, anchored to the checkout it sits in, can
// never reach a real session of this one.
const checkout = mkdtempSync(path.join(tmpdir(), "idlebiz-devkill-"));
const script = path.join(checkout, "apps/desktop/scripts/devkill.sh");
mkdirSync(path.dirname(script), { recursive: true });
copyFileSync(path.join(import.meta.dirname, "devkill.sh"), script);
const shell = path.join(checkout, "apps/desktop/src-tauri/target/debug/idlebiz-desktop");
const main = path.join(checkout, "apps/desktop/.output/main/index.js");

const started: ChildProcess[] = [];
afterAll(() => {
  for (const child of started) {
    child.kill("SIGKILL");
  }
  rmSync(checkout, { force: true, recursive: true });
});

/** `program` under a command line that starts `argv`, as pgrep -f sees it. */
const standIn = (argv: string, program = "sleep 60"): ChildProcess => {
  const child = spawn("bash", ["-c", `exec -a "$0" ${program}`, argv], { stdio: "ignore" });
  started.push(child);
  return child;
};

const devkill = async (): Promise<void> => {
  await once(spawn("bash", [script], { stdio: "ignore" }), "close");
};

const alive = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

describe("devkill", () => {
  it("stops the dev session's shell and leaves e2e's main running", async () => {
    const dev = standIn(shell);
    const e2e = standIn(`node ${main}`);
    await sleep(200);

    await devkill();
    await sleep(200);

    expect(alive(dev)).toBe(false);
    expect(alive(e2e)).toBe(true);
  }, 20_000);

  it("stops what tauri dev started, whatever its command line", async () => {
    const helper = path.join(checkout, "helper-pid");
    const tauri = standIn(
      `node ${path.join(checkout, "apps/desktop/node_modules/.bin/../@tauri-apps/cli/tauri.js")} dev --additional-watch-folders .output/main`,
      `bash -c "sleep 60 & echo \\$! > ${helper}; wait"`,
    );
    await sleep(200);
    const pid = Number(readFileSync(helper, "utf-8"));

    await devkill();
    await sleep(200);

    expect(alive(tauri)).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);
});
