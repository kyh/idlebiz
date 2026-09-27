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
const electron = path.join(
  checkout,
  "node_modules/.pnpm/electron@44.4.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);

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
  it("stops the dev session's Electron and leaves an e2e launch of the same binary running", async () => {
    const dev = standIn(`${electron} . --remote-debugging-port=9222`);
    const e2e = standIn(
      `${electron} --inspect=0 --remote-debugging-port=0 ${path.join(checkout, "apps/desktop")}`,
    );
    await sleep(200);

    await devkill();
    await sleep(200);

    expect(alive(dev)).toBe(false);
    expect(alive(e2e)).toBe(true);
  }, 20_000);

  it("stops what electron-vite started, whatever its command line", async () => {
    const helper = path.join(checkout, "helper-pid");
    const vite = standIn(
      `${path.join(checkout, "apps/desktop/node_modules/electron-vite/bin/electron-vite.js")} dev`,
      `bash -c "sleep 60 & echo \\$! > ${helper}; wait"`,
    );
    await sleep(200);
    const pid = Number(readFileSync(helper, "utf-8"));

    await devkill();
    await sleep(200);

    expect(alive(vite)).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);
});
