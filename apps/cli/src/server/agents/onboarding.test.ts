import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerProbe } from "@repo/agent-driver/detect";
import type { Argv } from "@repo/agent-driver/registry";
import type { AuthFlowEvent } from "@repo/domain/domain";
import { SYSTEM_PATH } from "../lib/founder-env";
import { CLAUDE_INSTALLER, cancelLogin, startLogin } from "./onboarding";

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

/** No CLI installed, nor made by `installer`, which installs nothing. */
const noneInstalled = (installer: Argv) => ({
  ...signedOutClaude([process.execPath, "-e", ""]),
  installer,
  refresh: (): Promise<RunnerProbe[]> =>
    Promise.resolve([{ bin: "claude", id: "claude", installed: false }]),
});

// A command that prints each name in its env on a line of its own, and its PATH.
const PRINTS_ITS_ENV: Argv = [
  process.execPath,
  "-e",
  'for (const name of Object.keys(process.env)) console.log("env " + name); console.log("PATH is " + (process.env.PATH ?? ""));',
];

/** What a command that `PRINTS_ITS_ENV` printed, as the setup heard it. */
const printed = (heard: readonly AuthFlowEvent[]): string[] =>
  heard.flatMap((e) => (e.type === "progress" ? [e.message] : []));

/** The names of the env a command that `PRINTS_ITS_ENV` was started on. */
const namesIn = (heard: readonly AuthFlowEvent[]): string[] =>
  printed(heard).flatMap((line) => (line.startsWith("env ") ? [line.slice("env ".length)] : []));

// what a `launchctl setenv` could have left in main's env, which is launchd's in the app
const LAUNCHD_SET = [
  "BASH_ENV",
  "BASH_FUNC_curl%%",
  "BROWSER",
  "CURL_CA_BUNDLE",
  "CURL_HOME",
  "GH_TOKEN",
] as const;

const setByLaunchd = (base: string): void => {
  for (const name of LAUNCHD_SET) {
    vi.stubEnv(name, path.join(base, "planted"));
  }
};

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

describe("Claude Code's installer", () => {
  it("names each program it runs by its path, none looked up on PATH", () => {
    const [shell, flag, pipeline = ""] = CLAUDE_INSTALLER;
    expect([shell, flag]).toEqual(["/bin/bash", "-c"]);
    expect(pipeline.split("|").map((command) => command.trim().split(" ")[0])).toEqual([
      "/usr/bin/curl",
      "/bin/bash",
    ]);
  });
});

describe("a CLI's sign-in", () => {
  let base = "";

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "idlebiz-sign-in-"));
  });

  afterEach(() => {
    cancelLogin(() => {});
    vi.unstubAllEnvs();
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

  it("ends at once when cancelled while it is still looking for the CLIs", async () => {
    const heard: AuthFlowEvent[] = [];
    const stillLooking = {
      ...signedOutClaude([process.execPath, "-e", ""]),
      refresh: (): Promise<RunnerProbe[]> => Promise.withResolvers<RunnerProbe[]>().promise,
    };
    const settled = startLogin(stillLooking, (e) => heard.push(e));

    cancelLogin((e) => heard.push(e));
    await settled;

    expect(heard).toEqual([CANCELLED]);
  }, 1000);

  it("says it was cancelled when cancelled while it installs a CLI", async () => {
    const heard: AuthFlowEvent[] = [];
    // an installer whose download never ends
    const installing = noneInstalled([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
    const settled = startLogin(installing, (e) => heard.push(e));
    await vi.waitFor(() => {
      expect(heard).toContainEqual({
        message: "No coding CLI found — installing Claude Code…",
        type: "progress",
      });
    });

    cancelLogin((e) => heard.push(e));
    await settled;

    expect(heard.at(-1)).toEqual(CANCELLED);
  }, 10_000);

  it("installs a CLI on the account's names, the system's PATH and the founder's proxies alone", async () => {
    setByLaunchd(base);
    vi.stubEnv("HOME", base);
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:3128");
    vi.stubEnv("PATH", `${path.join(base, "bin")}:${SYSTEM_PATH}`);
    const heard: AuthFlowEvent[] = [];

    await startLogin(noneInstalled(PRINTS_ITS_ENV), (e) => heard.push(e));

    expect(namesIn(heard)).toEqual(expect.arrayContaining(["HOME", "HTTPS_PROXY", "PATH"]));
    expect(namesIn(heard).filter((name) => LAUNCHD_SET.some((set) => set === name))).toEqual([]);
    expect(printed(heard)).toContain(`PATH is ${SYSTEM_PATH}`);
  });

  it("signs a CLI in on the account's names, main's PATH, the proxies and its runner's own settings alone", async () => {
    setByLaunchd(base);
    vi.stubEnv("HOME", base);
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:3128");
    vi.stubEnv("PATH", `${path.join(base, "bin")}:${SYSTEM_PATH}`);
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(base, "claude"));
    vi.stubEnv("ANTHROPIC_MODEL", "opus");
    vi.stubEnv("CODEX_HOME", path.join(base, "codex"));
    const heard: AuthFlowEvent[] = [];

    await startLogin(signedOutClaude(PRINTS_ITS_ENV), (e) => heard.push(e));

    expect(namesIn(heard)).toEqual(
      expect.arrayContaining([
        "ANTHROPIC_MODEL",
        "CLAUDE_CONFIG_DIR",
        "HOME",
        "HTTPS_PROXY",
        "PATH",
      ]),
    );
    expect(namesIn(heard)).not.toContain("CODEX_HOME");
    expect(namesIn(heard).filter((name) => LAUNCHD_SET.some((set) => set === name))).toEqual([]);
    expect(printed(heard)).toContain(`PATH is ${path.join(base, "bin")}:${SYSTEM_PATH}`);
  });

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
