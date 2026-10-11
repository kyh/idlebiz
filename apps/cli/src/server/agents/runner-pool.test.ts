import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addUsage, zeroUsage } from "@repo/agent-driver/events";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthFlowEvent, RunOutcome } from "@repo/domain/domain";
import type { Seal, SealState } from "./seal";

const { SEAL, SKILLS, found, root } = await import("./fixtures");
const store = await import("../store/store");
const { agentDriver, createAgentDriver, memoryAfter, outcomeOf, resumeIn } =
  await import("./runner-pool");
const { askBox } = await import("./ask-box");
const { signInCommand } = await import("./seal");
const { controlPlane } = await import("../control-plane");
const { startLogin } = await import("./onboarding");

const failed = {
  class: "other",
  error: "exceeded the 45m session limit — killed",
  kind: "failed",
} as const;
const limited = {
  class: "usage-limit",
  error: "You've hit your session limit",
  kind: "failed",
  reportedReset: null,
} as const;
const overloaded = {
  class: "overloaded",
  error: "API Error: 529 Overloaded",
  kind: "failed",
} as const;
const accessRefused = {
  class: "access-denied",
  error: "Your organization must verify before using the API.",
  kind: "failed",
} as const;
const refusedLogin = { class: "auth", error: "Failed to authenticate", kind: "failed" } as const;

/** Until when an outcome rests its runner; 0 when it does not. */
const untilOf = (outcome: RunOutcome): number => (outcome.kind === "resting" ? outcome.until : 0);

describe("addUsage", () => {
  it("counts both attempts of a retried turn, dollars as already priced", () => {
    const stale = { cachedTokens: 1, costUsd: 0.02, inputTokens: 10, outputTokens: 0 };
    const fresh = { cachedTokens: 5, costUsd: 0.5, inputTokens: 200, outputTokens: 40 };
    expect(addUsage(stale, fresh)).toEqual({
      cachedTokens: 6,
      costUsd: 0.52,
      inputTokens: 210,
      outputTokens: 40,
    });
    expect(addUsage(zeroUsage(), fresh)).toEqual(fresh);
  });
});

describe("outcomeOf", () => {
  const resting = {
    cause: "usage-limit",
    error: limited.error,
    kind: "resting",
    until: 99,
  } as const;
  const failure = { error: failed.error, kind: "failed" } as const;
  const signedOut = { error: refusedLogin.error, kind: "signedOut" } as const;

  it("is how the turn left its runner when nothing was asked", () => {
    expect(outcomeOf({ kind: "done" }, null, false)).toEqual({ kind: "done" });
    expect(outcomeOf(resting, null, false)).toEqual(resting);
    expect(outcomeOf(failure, null, false)).toEqual(failure);
    expect(outcomeOf(signedOut, null, false)).toEqual(signedOut);
  });

  it("waits on the founder whenever something was asked, however the turn ended", () => {
    const ask = { question: "Ship it?", type: "question" } as const;
    expect(outcomeOf(resting, ask, false)).toEqual({ ask, kind: "blocked" });
    expect(outcomeOf(failure, ask, true)).toEqual({ ask, kind: "blocked" });
  });

  it("does not hold the task to a turn the app stopped, unless it finished anyway", () => {
    expect(outcomeOf(failure, null, true)).toEqual({ kind: "interrupted" });
    expect(outcomeOf(signedOut, null, true)).toEqual({ kind: "interrupted" });
    expect(outcomeOf({ kind: "done" }, null, true)).toEqual({ kind: "done" });
  });
});

/** A driver whose check holds, keeping its runners' rests in `rest`. */
const driverOn = (rest: string | null) =>
  createAgentDriver(
    () => Promise.resolve({ kind: "sealed" }),
    () => Promise.resolve(SEAL),
    () => SKILLS,
    () => rest,
  );

describe("a limit a turn hit", () => {
  const hour = 3_600_000;

  it("parks a runner until the reset its provider reported, and only that runner", () => {
    const until = Date.now() + 60_000;
    agentDriver.heed("claude", { ...limited, reportedReset: until });
    expect(agentDriver.restingRunner("claude")).toBe(until);
    expect(agentDriver.restingRunner("codex")).toBeNull();
    expect(agentDriver.restingRunners()).toEqual({ claude: until });
  });

  it("wakes a runner once its limit has lifted", () => {
    agentDriver.heed("codex", { ...limited, reportedReset: Date.now() - 1 });
    expect(agentDriver.restingRunner("codex")).toBeNull();
    expect(agentDriver.restingRunners()).not.toHaveProperty("codex");
  });

  it("rests a runner half an hour when its provider named no reset", () => {
    const driver = driverOn(null);
    const before = Date.now();
    const outcome = driver.heed("claude", limited);
    expect(outcome).toMatchObject({ cause: "usage-limit", error: limited.error, kind: "resting" });
    expect(untilOf(outcome)).toBeGreaterThanOrEqual(before + hour / 2);
    expect(untilOf(outcome)).toBeLessThanOrEqual(Date.now() + hour / 2);
    expect(driver.restingRunner("claude")).toBe(untilOf(outcome));
  });

  it("never rests a runner past 12 hours, whatever reset was named", () => {
    const driver = driverOn(null);
    const before = Date.now();
    const outcome = driver.heed("claude", { ...limited, reportedReset: before + 72 * hour });
    expect(untilOf(outcome)).toBeGreaterThanOrEqual(before + 12 * hour);
    expect(untilOf(outcome)).toBeLessThanOrEqual(Date.now() + 12 * hour);
  });

  it("fails the task, resting no runner, on any failure that is not the runner's", () => {
    const driver = driverOn(null);
    expect(driver.heed("codex", failed)).toEqual({ error: failed.error, kind: "failed" });
    const spent = { class: "context", error: "context window exceeded", kind: "failed" } as const;
    expect(driver.heed("codex", spent)).toEqual({ error: spent.error, kind: "failed" });
    expect(driver.restingRunners()).toEqual({});
    expect(driver.heed("codex", { kind: "completed" })).toEqual({ kind: "done" });
  });
});

describe("an overloaded provider", () => {
  const minute = 60_000;
  const driver = createAgentDriver(
    () => Promise.resolve({ kind: "sealed" }),
    () => Promise.resolve(SEAL),
    () => SKILLS,
    () => null,
  );

  /** How long the next overload rests codex, by the outcome heed hands back. */
  const restAfterOverload = (): number => {
    const before = Date.now();
    const until = untilOf(driver.heed("codex", overloaded));
    expect(driver.restingRunner("codex")).toBe(until);
    return Math.round((until - before) / minute);
  };

  it("rests the runner for a minute, doubling with each in a row up to a quarter hour", () => {
    expect([1, 2, 3, 4, 5, 6].map(restAfterOverload)).toEqual([1, 2, 4, 8, 15, 15]);
  });

  it("starts at a minute again once a turn ends another way", () => {
    const fresh = createAgentDriver(
      () => Promise.resolve({ kind: "sealed" }),
      () => Promise.resolve(SEAL),
      () => SKILLS,
      () => null,
    );
    const rest = (): number => {
      const before = Date.now();
      return Math.round((untilOf(fresh.heed("claude", overloaded)) - before) / minute);
    };
    expect(rest()).toBe(1);
    expect(rest()).toBe(2);
    const held = fresh.restingRunner("claude");
    fresh.heed("claude", failed);
    // the next asks a minute, so the 2m rest still holding stands
    expect(untilOf(fresh.heed("claude", overloaded))).toBe(held);
    // and the one after asks 2m, not the 8m a streak never broken would
    expect(rest()).toBe(2);
  });

  it("never shortens a usage limit's rest, which a turn still in flight may end under", () => {
    const fresh = createAgentDriver(
      () => Promise.resolve({ kind: "sealed" }),
      () => Promise.resolve(SEAL),
      () => SKILLS,
      () => null,
    );
    const lifts = Date.now() + 3 * 3_600_000;
    fresh.heed("claude", { ...limited, reportedReset: lifts });
    expect(fresh.heed("claude", overloaded)).toMatchObject({ until: lifts });
    expect(outcomeOf(fresh.heed("claude", overloaded), null, false)).toMatchObject({
      kind: "resting",
      until: lifts,
    });
  });
});

describe("a provider refusing access no sign-in repairs", () => {
  const minute = 60_000;
  const restOf = (outcome: RunOutcome, before: number): number =>
    Math.round((untilOf(outcome) - before) / minute);

  it("rests the runner on an overload's backoff, never signing it out or spending the session", () => {
    const driver = driverOn(null);
    const signedInClaude = {
      authed: true,
      bin: "claude",
      id: "claude",
      installed: true,
      version: "1.0.0",
    } as const;
    const rests = [1, 2, 3, 4, 5].map(() =>
      restOf(driver.heed("claude", accessRefused), Date.now()),
    );
    expect(rests).toEqual([1, 2, 4, 8, 15]);
    expect(driver.needsSignIn(signedInClaude)).toBe(false);
    expect(outcomeOf(driver.heed("claude", accessRefused), null, false)).toMatchObject({
      cause: "access-denied",
      error: accessRefused.error,
      kind: "resting",
    });
  });

  it("shares one streak with an overload, which a turn ending another way starts over", () => {
    const driver = driverOn(null);
    expect(restOf(driver.heed("codex", overloaded), Date.now())).toBe(1);
    expect(restOf(driver.heed("codex", accessRefused), Date.now())).toBe(2);
    driver.heed("codex", failed);
    const held = driver.restingRunner("codex");
    // a minute asked: the 2m rest still holding stands
    expect(driver.heed("codex", accessRefused)).toMatchObject({ until: held });
  });
});

describe("a rest the last launch left", () => {
  const box = mkdtempSync(path.join(tmpdir(), "idlebiz-rest-"));
  const file = path.join(box, "state", "runner-rest.json");
  afterAll(() => rmSync(box, { force: true, recursive: true }));

  it("holds after a restart, so no parked task spawns once to be refused", async () => {
    const lifts = Date.now() + 3_600_000;
    driverOn(file).heed("claude", { ...limited, reportedReset: lifts });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ claude: lifts });

    const restarted = driverOn(file);
    restarted.init();
    await restarted.sealRefusal();
    expect(restarted.restingRunners()).toEqual({ claude: lifts });
  });

  it("drops a rest that lifted while the app was closed, and reads a missing or broken file as none", async () => {
    writeFileSync(file, JSON.stringify({ claude: Date.now() - 1, codex: Date.now() + 60_000 }));
    const restarted = driverOn(file);
    restarted.init();
    await restarted.sealRefusal();
    expect(Object.keys(restarted.restingRunners())).toEqual(["codex"]);

    writeFileSync(file, "{ not json");
    const broken = driverOn(file);
    broken.init();
    expect(broken.restingRunners()).toEqual({});

    const missing = driverOn(path.join(box, "missing", "runner-rest.json"));
    missing.init();
    expect(missing.restingRunners()).toEqual({});

    const none = driverOn(null);
    none.init();
    expect(none.restingRunners()).toEqual({});
    expect(none.heed("codex", { ...limited, reportedReset: Date.now() + 60_000 }).kind).toBe(
      "resting",
    );
  });
});

describe("memoryAfter", () => {
  const kept = { id: "kept", workspace: "/save/workspace" };
  const stored = { instructionsDigest: "old", session: kept };
  const ran = { id: "ran", workspace: "/save/products/b/workspace" };

  it("remembers the session the turn ran, where it ran, holding the instructions it was given", () => {
    expect(
      memoryAfter({ end: { kind: "completed" }, sessionId: "ran" }, stored, "new", ran.workspace),
    ).toEqual({ instructionsDigest: "new", session: ran });
    expect(memoryAfter({ end: failed, sessionId: "ran" }, stored, "new", ran.workspace)).toEqual({
      instructionsDigest: "new",
      session: ran,
    });
  });

  it("leaves what was stored when the turn opened no session", () => {
    expect(memoryAfter({ end: failed }, stored, "new", ran.workspace)).toEqual(stored);
  });

  it("forgets a session only a new one can follow", () => {
    const spent = { class: "context", error: "context window exceeded", kind: "failed" } as const;
    expect(memoryAfter({ end: spent, sessionId: "kept" }, stored, "new", kept.workspace)).toEqual({
      instructionsDigest: null,
      session: null,
    });
  });
});

describe("resumeIn", () => {
  const session = { id: "s1", workspace: "/save/products/a/workspace" };

  it("resumes a session in the folder it began in", () => {
    expect(resumeIn(session, "/save/products/a/workspace")).toBe("s1");
  });

  it("starts fresh in any other folder, where claude could not record the turn", () => {
    expect(resumeIn(session, "/save/products/b/workspace")).toBeUndefined();
    expect(resumeIn(null, "/save/products/a/workspace")).toBeUndefined();
  });
});

/** A claude whose stored login always reads as signed in, and whose sign-in exits `exit`. */
const storedLoginClaude = (exit: number): void => {
  const cli = path.join(root, "claude");
  const script = `case "$1 $2" in --version*) echo 1.0.0 ;; "auth login") exit ${exit} ;; *) echo '{"loggedIn": true}' ;; esac`;
  writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  process.env.CLAUDE_BIN = cli;
};
const signingIn = {
  message: "Signing in to Claude Code — your browser will open…",
  type: "progress",
};

/** Point both CLIs at nothing, so looking for them spawns no real one. */
const withoutClis = () => {
  const touched = ["CLAUDE_BIN", "CODEX_BIN"];
  const previous = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    for (const key of touched) {
      process.env[key] = path.join(root, `no-${key}`);
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stringifies an assigned undefined; delete is the only unset
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
};

describe("a seal the boot check refuses", () => {
  withoutClis();
  const refused: SealState = {
    kind: "refused",
    reason: "sandbox-exec timed out, so none will start.",
  };
  const holding: SealState = { kind: "sealed" };

  it("starts no run and says why, then checks again when the CLIs are looked for again", async () => {
    const verdicts = [refused, holding];
    let checks = 0;
    const driver = createAgentDriver(() => {
      checks += 1;
      return Promise.resolve(verdicts[checks - 1] ?? holding);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      driver.init();
      expect(driver.runsSealed()).toBe(false);
      expect(await driver.sealRefusal()).toBe("sandbox-exec timed out, so none will start.");
      expect(driver.runsSealed()).toBe(false);
      expect(logged).toHaveBeenCalledWith("[seal]", "sandbox-exec timed out, so none will start.");

      await driver.refresh();

      expect(await driver.sealRefusal()).toBeNull();
      expect(driver.runsSealed()).toBe(true);
      await driver.refresh();
      expect(checks).toBe(2);
    } finally {
      logged.mockRestore();
    }
  });
});

const onMac = process.platform === "darwin";

/** Whether a driver whose check holds finds a CLI ready, each probe under the seal `resolveSeal` gives. */
const anyRunnerUnder = async (resolveSeal: () => Promise<Seal>): Promise<boolean> => {
  const driver = createAgentDriver(() => Promise.resolve({ kind: "sealed" }), resolveSeal);
  driver.init();
  return await driver.hasAnyRunner();
};

describe.skipIf(!onMac)("the seal a run starts under", () => {
  withoutClis();
  // a claude that reads as installed only while the canary it tries is sealed from it
  let canary = "";
  beforeEach(() => {
    canary = path.join(realpathSync(root), "canary");
    writeFileSync(canary, "canary");
    const cli = path.join(root, "claude");
    const script = `[ "$1" = --version ] && { cat "${canary}" && exit 3; echo 1.0.0; } || echo '{"loggedIn": true}'`;
    writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    process.env.CLAUDE_BIN = cli;
  });
  const sealing = (): Seal => ({ ...SEAL, unreadable: [{ match: "subpath", path: canary }] });

  it("finds a CLI only under its seal, and none with no seal", async () => {
    expect(await anyRunnerUnder(() => Promise.resolve(sealing()))).toBe(true);
    expect(await anyRunnerUnder(() => Promise.resolve({ ...SEAL, unreadable: [] }))).toBe(false);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await anyRunnerUnder(() => Promise.reject(new Error("no seal")))).toBe(false);
      expect(logged).toHaveBeenCalledWith("[probe]", new Error("no seal"));
    } finally {
      logged.mockRestore();
    }
  });

  it("signs a CLI in under its runner's seal, free to open the browser, and not at all while the seal is refused", async () => {
    const sealed = createAgentDriver(
      () => Promise.resolve({ kind: "sealed" }),
      () => Promise.resolve(sealing()),
    );
    sealed.init();
    expect(await sealed.sealedSignIn("codex", ["codex", "login"])).toEqual(
      signInCommand(sealing(), "codex", ["codex", "login"]),
    );
    const refused = createAgentDriver(
      () => Promise.resolve({ kind: "refused", reason: "no sandbox-exec here." }),
      () => Promise.resolve(sealing()),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      refused.init();
      await expect(refused.sealedSignIn("claude", ["claude", "auth", "login"])).rejects.toThrow(
        "no sandbox-exec here.",
      );
      expect(await refused.hasAnyRunner()).toBe(false);
    } finally {
      logged.mockRestore();
    }
  });

  it("checks the seal only once main's PATH has settled, and starts no run before", async () => {
    const shellAnswered = Promise.withResolvers<null>();
    let checked = 0;
    const driver = createAgentDriver(
      () => {
        checked += 1;
        return Promise.resolve({ kind: "sealed" });
      },
      () => Promise.resolve(sealing()),
    );
    driver.init(
      (async () => {
        await shellAnswered.promise;
      })(),
    );
    await Promise.resolve();
    expect(checked).toBe(0);
    expect(driver.runsSealed()).toBe(false);

    shellAnswered.resolve(null);

    expect(await driver.sealRefusal()).toBeNull();
    expect(checked).toBe(1);
    expect(driver.runsSealed()).toBe(true);
  });

  it("is resolved again for every run, and none starts without one", async () => {
    let resolved = 0;
    const driver = createAgentDriver(
      () => Promise.resolve({ kind: "sealed" }),
      () => {
        resolved += 1;
        return resolved === 1
          ? Promise.resolve(sealing())
          : Promise.reject(new Error(`no seal ${resolved}`));
      },
    );
    driver.init();
    expect(await driver.hasAnyRunner()).toBe(true);
    await expect(driver.completeOneShot("hire")).rejects.toThrow("no seal 2");
    await expect(driver.completeOneShot("hire")).rejects.toThrow("no seal 3");
  });

  it("reads a runner whose login a turn found refused as signed out, however often its stored login is read again", async () => {
    storedLoginClaude(0);
    const driver = createAgentDriver(
      () => Promise.resolve({ kind: "sealed" }),
      () => Promise.resolve(SEAL),
    );
    driver.init();
    expect(await driver.hasAnyRunner()).toBe(true);
    expect(await driver.signedOut()).toEqual(["codex"]);

    driver.heed("claude", refusedLogin);

    expect(driver.signedIn("claude")).toBe(false);
    expect(await driver.hasAnyRunner()).toBe(false);
    await driver.refresh();
    expect(await driver.signedOut()).toEqual(["claude", "codex"]);
  });

  it("signs a refused login in again, though its stored login reads as signed in, and counts it only once that sign-in succeeds", async () => {
    const driver = createAgentDriver(
      () => Promise.resolve({ kind: "sealed" }),
      () => Promise.resolve(SEAL),
    );
    storedLoginClaude(1);
    driver.init();
    driver.heed("claude", refusedLogin);
    const heard: AuthFlowEvent[] = [];
    await startLogin(driver, (e) => heard.push(e));
    expect(heard).toContainEqual(signingIn);
    expect(heard).not.toContainEqual({ type: "done" });
    expect(driver.signedIn("claude")).toBe(false);

    storedLoginClaude(0);
    heard.length = 0;
    await startLogin(driver, (e) => heard.push(e));
    expect(heard).toContainEqual(signingIn);
    expect(heard).toContainEqual({ type: "done" });
    expect(await driver.signedOut()).toEqual(["codex"]);
  });

  it("lets a task's run write only its own folders in the save, and the hiring one-shot none", async () => {
    const asked: (readonly string[])[] = [];
    const driver = createAgentDriver(
      () => Promise.resolve({ kind: "sealed" }),
      (writable) => {
        asked.push(writable);
        return asked.length === 1
          ? Promise.resolve(sealing())
          : Promise.reject(new Error("no seal"));
      },
    );
    driver.init();
    await driver.hasAnyRunner();
    const company = found();
    const [emp] = store.listEmployees();
    const [product] = store.listProducts();
    if (emp === undefined || product === undefined) {
      throw new Error("founded without a hire or a product");
    }
    const task = { description: "", id: "t", title: "work", workspace: product.workspaceDir };
    const tools = {
      asks: askBox(() => {}),
      call: () => Promise.reject(new Error("called a tool without a test asking for it")),
    };
    await expect(driver.completeOneShot("hire")).rejects.toThrow("no seal");
    // as at boot: a task's run opens its socket first, since its seal names it
    await controlPlane.start();
    try {
      await expect(
        driver.runTask(emp, company, task, () => {}, tools, new AbortController().signal),
      ).rejects.toThrow("no seal");
    } finally {
      controlPlane.stop();
    }
    expect(asked).toEqual([
      [],
      [],
      [
        product.workspaceDir,
        company.workspaceDir,
        path.join(root, "company", "agents", emp.id, "memory"),
        path.join(root, "cache"),
      ],
    ]);
  });
});
