import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { endAllAgents, runAcpTurn } from "@repo/agent-driver/acp-session";
import { afterEach, describe, expect, it } from "vitest";

// Never answers ACP and runs a child of its own, in its process group.
const withChild = (onTerm: string): string => `
process.on("SIGTERM", () => { ${onTerm} });
require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
require("node:fs").writeFileSync("pid", String(process.pid));
setInterval(() => {}, 1000);
`;

// An adapter wedged with its CLI still running.
const WEDGED_AGENT = withChild("");

// codex-acp: dies on SIGTERM, leaving its app-server behind.
const ORPHANING_AGENT = withChild("process.exit(0);");

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

const pidIn = async (dir: string): Promise<number> => {
  for (let tries = 0; tries < 100; tries += 1) {
    try {
      const pid = Number(readFileSync(path.join(dir, "pid"), "utf-8"));
      // an empty read is 0, and a signal to group 0 would land on this test runner
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      /* not written yet */
    }
    await delay(50);
  }
  throw new Error("the agent never started");
};

const goneWithin = async (pgid: number, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) {
      return true;
    }
    await delay(25);
  }
  return !groupAlive(pgid);
};

let cwd = "";
let pgid: number | null = null;

afterEach(() => {
  if (pgid !== null && groupAlive(pgid)) {
    process.kill(-pgid, "SIGKILL");
  }
  pgid = null;
  rmSync(cwd, { force: true, recursive: true });
});

const startTurn = (script: string, teardownGraceMs: number) => {
  cwd = mkdtempSync(path.join(tmpdir(), "idlebiz-teardown-"));
  const stop = new AbortController();
  const turn = runAcpTurn({
    agent: { command: [process.execPath, "-e", script], sessionModeId: "default" },
    cwd,
    idleTimeoutMs: 0,
    maxSessionMs: 0,
    onEvent: () => {},
    prompt: "work",
    signal: stop.signal,
    systemPrompt: "",
    teardownGraceMs,
  });
  return { stop, turn };
};

describe("tearing a turn down", () => {
  it("gives the agent its grace period, then kills its whole process group", async () => {
    const { stop, turn } = startTurn(WEDGED_AGENT, 300);
    pgid = await pidIn(cwd);

    stop.abort();
    const { end } = await turn;
    expect(end.kind).toBe("failed");
    expect(groupAlive(pgid)).toBe(true);
    expect(await goneWithin(pgid, 3000)).toBe(true);
  });
});

describe("ending every agent before the app exits", () => {
  it("kills a group its leader left behind without waiting out the grace", async () => {
    const { stop, turn } = startTurn(ORPHANING_AGENT, 60_000);
    pgid = await pidIn(cwd);
    stop.abort();
    await turn;

    const started = Date.now();
    await endAllAgents(60_000);

    expect(Date.now() - started).toBeLessThan(2000);
    expect(await goneWithin(pgid, 1000)).toBe(true);
  });

  it("stops an agent whose turn is still going", async () => {
    const { turn } = startTurn(ORPHANING_AGENT, 60_000);
    pgid = await pidIn(cwd);

    await endAllAgents(60_000);

    const { end } = await turn;
    expect(end.kind).toBe("failed");
    expect(await goneWithin(pgid, 1000)).toBe(true);
  });

  it("gives a wedged agent the grace, then kills its group", async () => {
    const { stop, turn } = startTurn(WEDGED_AGENT, 60_000);
    pgid = await pidIn(cwd);
    stop.abort();
    await turn;

    const ending = endAllAgents(300);
    await delay(100);
    expect(groupAlive(pgid)).toBe(true);

    await ending;
    expect(await goneWithin(pgid, 1000)).toBe(true);
  });
});
