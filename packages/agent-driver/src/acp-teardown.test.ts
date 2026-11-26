import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { endAllAgents, runAcpTurn } from "./acp-session";
import { afterEach, describe, expect, it } from "vitest";

const withChild = (onTerm: string) => `
process.on("SIGTERM", () => { ${onTerm} });
require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
require("node:fs").writeFileSync("pid", String(process.pid));
setInterval(() => {}, 1000);
`;

const WEDGED_AGENT = withChild('require("node:fs").writeFileSync("termed", "");');

const ORPHANING_AGENT = withChild("process.exit(0);");

const statOf = (pid: string) => {
  try {
    const stat = readFileSync(path.join("/proc", pid, "stat"), "utf-8");
    const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");

    return { pgrp: Number(pgrp), state };
  } catch {
    return null;
  }
};

const unreaped = (state: string | undefined) => state === "Z" || state === "X";

const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
  } catch {
    return false;
  }

  if (!existsSync("/proc/self/stat")) {
    return true;
  }

  return readdirSync("/proc").some((pid) => {
    const stat = /^\d+$/u.test(pid) ? statOf(pid) : null;

    return stat?.pgrp === pgid && !unreaped(stat.state);
  });
};

const written = (dir: string, name: string, done: (text: string) => boolean) => {
  const file = path.join(dir, name);
  const { promise, resolve } = Promise.withResolvers<string>();

  const check = () => {
    const text = existsSync(file) ? readFileSync(file, "utf-8") : null;

    if (text !== null && done(text)) {
      watcher.close();
      resolve(text);
    }
  };

  const watcher = watch(dir, check);
  check();

  return promise;
};

const isPid = (text: string) => Number.isInteger(Number(text)) && Number(text) > 0;

const pidIn = async (dir: string) => Number(await written(dir, "pid", isPid));

const goneWithin = async (pgid: number, ms: number) => {
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
    agent: { command: [process.execPath, "-e", script], env: {}, sessionMode: () => "default" },
    cwd,
    idleTimeoutMs: 0,
    maxSessionMs: 0,
    onEvent: () => {},
    onPermission: () => Promise.resolve({ allow: true }),
    prompt: () => "work",
    signal: stop.signal,
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

    const termed = written(cwd, "termed", () => true);
    const ending = endAllAgents(300);
    await termed;
    expect(groupAlive(pgid)).toBe(true);

    await ending;
    expect(await goneWithin(pgid, 1000)).toBe(true);
  });
});
