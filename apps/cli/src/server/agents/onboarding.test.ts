import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerProbe } from "@repo/agent-driver/detect";
import type { Argv } from "@repo/agent-driver/registry";
import type { AuthFlowEvent } from "@repo/domain/domain";
import { cancelLogin, startLogin } from "./onboarding";

const LOGIN_URL = { type: "url", url: "https://claude.test/oauth/authorize" } as const;
const CANCELLED = { message: "Setup cancelled.", type: "error" } as const;

// A login that never finishes: it starts a helper, writes its own pid and the helper's to the
// file it is handed, prints where to sign in and waits, holding on through a SIGTERM.
const NEVER_FINISHES = `
const { spawn } = require("node:child_process");
const helper = spawn("sleep", ["600"], { stdio: "ignore" });
process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(process.argv[1], \`\${process.pid} \${helper.pid}\`);
console.log("Opening ${LOGIN_URL.url}");
setInterval(() => {}, 1000);
`;

/** A claude CLI that is installed and signed out, until the login `argv` runs to success. */
const signedOutClaude = (argv: Argv) => {
  let authed = false;
  const probe = (): RunnerProbe => ({
    authed,
    bin: "claude",
    id: "claude",
    installed: true,
    version: "1.0.0",
  });
  return {
    needsSignIn: (p: RunnerProbe): boolean => p.installed && !p.authed,
    refresh: (): Promise<RunnerProbe[]> => Promise.resolve([probe()]),
    sealRefusal: (): Promise<string | null> => Promise.resolve(null),
    sealedSignIn: (): Promise<Argv> => Promise.resolve(argv),
    signedInAgain: (): void => {
      authed = true;
    },
  };
};

/** A claude whose login never finishes, writing its pids to `pids`. */
const neverFinishing = (pids: string) =>
  signedOutClaude([process.execPath, "-e", NEVER_FINISHES, pids]);

const pidsIn = (file: string): number[] => readFileSync(file, "utf-8").split(" ").map(Number);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits out the group's grace: the login holds on through SIGTERM, so only SIGKILL ends it. */
const goneIn = async (file: string): Promise<void> => {
  await vi.waitFor(
    () => {
      expect(pidsIn(file).filter(alive)).toEqual([]);
    },
    { interval: 100, timeout: 5000 },
  );
};

describe("a CLI's sign-in", () => {
  let base = "";

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "idlebiz-sign-in-"));
  });

  afterEach(() => {
    cancelLogin(() => {});
    rmSync(base, { force: true, recursive: true });
  });

  it("counts a login that finishes", async () => {
    const heard: AuthFlowEvent[] = [];
    await startLogin(signedOutClaude([process.execPath, "-e", "console.log('Logged in')"]), (e) =>
      heard.push(e),
    );
    expect(heard).toContainEqual({ message: "Logged in", type: "progress" });
    expect(heard.at(-1)).toEqual({ type: "done" });
  });

  it("is stopped with what it started when cancelled, and ends in an error that frees the next", async () => {
    const pids = path.join(base, "pids");
    const heard: AuthFlowEvent[] = [];
    const settled = startLogin(neverFinishing(pids), (e) => heard.push(e));
    await vi.waitFor(() => {
      expect(heard).toContainEqual(LOGIN_URL);
    });
    expect(pidsIn(pids).every(alive)).toBe(true);

    cancelLogin((e) => heard.push(e));
    await settled;

    expect(heard.at(-1)).toEqual(CANCELLED);
    await goneIn(pids);
    const after: AuthFlowEvent[] = [];
    cancelLogin((e) => after.push(e));
    expect(after).toEqual([{ message: "No setup was under way.", type: "error" }]);
  }, 10_000);

  it("is stopped with what it started once its time is up, and says so", async () => {
    const pids = path.join(base, "pids");
    const heard: AuthFlowEvent[] = [];
    await startLogin(neverFinishing(pids), (e) => heard.push(e), 2000);

    expect(heard).toContainEqual(LOGIN_URL);
    expect(heard.at(-1)).toEqual({
      message: "The sign-in to Claude Code timed out — sign in again.",
      type: "error",
    });
    await goneIn(pids);
  }, 10_000);

  it("gives way to a retry, which stops it and speaks for both", async () => {
    const first = path.join(base, "first");
    const second = path.join(base, "second");
    const heardFirst: AuthFlowEvent[] = [];
    const heardSecond: AuthFlowEvent[] = [];
    const firstSettled = startLogin(neverFinishing(first), (e) => heardFirst.push(e));
    await vi.waitFor(() => {
      expect(heardFirst).toContainEqual(LOGIN_URL);
    });

    const secondSettled = startLogin(neverFinishing(second), (e) => heardSecond.push(e));
    await firstSettled;
    expect(heardFirst.at(-1)).toEqual(LOGIN_URL);
    await vi.waitFor(() => {
      expect(heardSecond).toContainEqual(LOGIN_URL);
    });
    await goneIn(first);
    expect(pidsIn(second).every(alive)).toBe(true);

    cancelLogin((e) => heardSecond.push(e));
    await secondSettled;
    expect(heardSecond.at(-1)).toEqual(CANCELLED);
    await goneIn(second);
  }, 15_000);
});
