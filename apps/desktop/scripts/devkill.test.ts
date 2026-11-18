import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const checkout = mkdtempSync(path.join(tmpdir(), "idlebiz-devkill-"));
const script = path.join(checkout, "apps/desktop/scripts/devkill.sh");

mkdirSync(path.dirname(script), { recursive: true });

copyFileSync(path.join(import.meta.dirname, "devkill.sh"), script);

const shell = path.join(checkout, "apps/desktop/src-tauri/target/debug/idlebiz-desktop");
const main = path.join(checkout, "apps/cli/dist/index.js");

const started: ChildProcess[] = [];

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

afterAll(() => {
  for (const child of started) {
    child.kill("SIGKILL");
  }

  rmSync(checkout, { force: true, recursive: true });
});

const standIn = async (argv: string, program = "sleep 60") => {
  const child = spawn("bash", ["-c", `exec -a "$0" ${program}`, argv], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  started.push(child);
  await once(child, "spawn");

  return child;
};

const exited = async (child: ChildProcess) => {
  if (alive(child)) {
    await once(child, "exit");
  }
};

const devkill = async () => {
  await once(spawn("bash", [script], { stdio: "ignore" }), "close");
};

describe("devkill", () => {
  it("stops the dev session's shell and leaves e2e's main running", async () => {
    const dev = await standIn(shell);
    const e2e = await standIn(`node ${main} serve`);

    await devkill();
    await exited(dev);

    expect(alive(dev)).toBe(false);
    expect(alive(e2e)).toBe(true);
  });

  it("stops what tauri dev started, whatever its command line", async () => {
    const helper = path.join(checkout, "helper-pid");

    const tauri = await standIn(
      `node ${checkout}/apps/desktop/node_modules/.bin/../@tauri-apps/cli/tauri.js dev --additional-watch-folders ../cli/dist`,
      `bash -c "sleep 60 & echo \\$! > ${helper}; echo ready; wait"`,
    );

    if (tauri.stdout) {
      await once(tauri.stdout, "data");
    }

    const pid = Number(readFileSync(helper, "utf-8"));

    await devkill();
    await exited(tauri);

    expect(alive(tauri)).toBe(false);
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    });
  });
});
