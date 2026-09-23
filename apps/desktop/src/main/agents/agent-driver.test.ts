import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addUsage, zeroUsage } from "@repo/agent-driver/events";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { BlockedAsk } from "@/shared/domain";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-driver-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const store = await import("@/main/store/store");
const { agentDriver, decidePermission, memoryAfter, outcomeOf } = await import("./agent-driver");

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env["IDLEBIZ_ROOT_DIR"];
  } else {
    process.env["IDLEBIZ_ROOT_DIR"] = previousRoot;
  }
});

const failed = { error: "exceeded the 45m session limit — killed", kind: "failed" } as const;
const limited = { error: "You've hit your session limit", kind: "limited", resetsAt: 99 } as const;

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
  it("is done when the turn completed with nothing asked", () => {
    expect(outcomeOf({ kind: "completed" }, null, false)).toEqual({ kind: "done" });
  });

  it("waits on the founder whenever something was asked, however the turn ended", () => {
    const ask = { question: "Ship it?", type: "question" } as const;
    expect(outcomeOf(limited, ask, false)).toEqual({ ask, kind: "blocked" });
    expect(outcomeOf(failed, ask, true)).toEqual({ ask, kind: "blocked" });
  });

  it("rests only when the agent refused the turn for a limit, whatever a failure says", () => {
    expect(outcomeOf(limited, null, false)).toEqual({
      error: limited.error,
      kind: "resting",
      until: 99,
    });
    expect(outcomeOf(failed, null, false)).toEqual({ error: failed.error, kind: "failed" });
  });

  it("does not hold the task to a turn the app stopped, unless it finished anyway", () => {
    expect(outcomeOf(failed, null, true)).toEqual({ kind: "interrupted" });
    expect(outcomeOf({ kind: "completed" }, null, true)).toEqual({ kind: "done" });
  });
});

describe("rest", () => {
  it("parks a runner until its limit lifts, and only that runner", () => {
    const until = Date.now() + 60_000;
    agentDriver.rest("claude", until);
    expect(agentDriver.restingRunner("claude")).toBe(until);
    expect(agentDriver.restingRunner("codex")).toBeNull();
    expect(agentDriver.restingRunners()).toEqual({ claude: until });
  });

  it("wakes a runner once its limit has lifted", () => {
    agentDriver.rest("codex", Date.now() - 1);
    expect(agentDriver.restingRunner("codex")).toBeNull();
    expect(agentDriver.restingRunners()).not.toHaveProperty("codex");
  });
});

describe("memoryAfter", () => {
  const stored = { instructionsDigest: "old", session: "kept" };

  it("remembers the session the turn ran, holding the instructions it was given", () => {
    expect(memoryAfter({ end: { kind: "completed" }, sessionId: "ran" }, stored, "new")).toEqual({
      instructionsDigest: "new",
      session: "ran",
    });
    expect(memoryAfter({ end: failed, sessionId: "ran" }, stored, "new")).toEqual({
      instructionsDigest: "new",
      session: "ran",
    });
  });

  it("leaves what was stored when the turn opened no session", () => {
    expect(memoryAfter({ end: failed }, stored, "new")).toEqual(stored);
  });

  it("forgets a session only a new one can follow", () => {
    const spent = { error: "context window exceeded", kind: "failed", sessionSpent: true } as const;
    expect(memoryAfter({ end: spent, sessionId: "kept" }, stored, "new")).toEqual({
      instructionsDigest: null,
      session: null,
    });
  });
});

const found = () =>
  store.foundCompany({
    budget: { mode: "infinite" },
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    hires: [
      {
        name: "Mae",
        persona: "ships",
        role: "engineer",
        runner: "claude",
        spriteSeed: "Mae",
        title: "General Manager",
      },
    ],
    mission: "ship",
    name: "Acme",
  });

describe("decidePermission", () => {
  const push = { tool: { command: "git push", kind: "shell" } } as const;
  const workspace = path.join(root, "acme", "workspace");
  const room = { cwd: workspace, save: root, writable: [workspace] };

  /** A company whose founder signed for one `git push` on task "deploy". */
  const signedFor = () => {
    const company = found();
    store.grantApproval("deploy", "git push");
    const asked: BlockedAsk[] = [];
    const decide = (signal: AbortSignal) =>
      decidePermission(
        { companyId: company.id, id: "deploy" },
        push,
        new Set(),
        room,
        (ask) => asked.push(ask),
        signal,
      );
    return { asked, decide };
  };

  it("spends the sign-off on a live turn", async () => {
    const { asked, decide } = signedFor();
    expect(await decide(new AbortController().signal)).toEqual({ allow: true });
    expect(store.consumeApproval("deploy", "git push")).toBe(false);
    expect(asked).toEqual([]);
  });

  it("asks the founder before a run edits the save behind the store", async () => {
    const company = found();
    const asked: BlockedAsk[] = [];
    const request = { tool: { kind: "edit", paths: ["../approvals.json"] } } as const;
    const decision = await decidePermission(
      { companyId: company.id, id: "deploy" },
      request,
      new Set(),
      room,
      (ask) => asked.push(ask),
      new AbortController().signal,
    );
    expect(decision).toEqual({ allow: false });
    expect(asked).toEqual([
      {
        command: `edit: ${path.join(root, "acme", "approvals.json")}`,
        rule: "save-edit",
        type: "approval",
      },
    ]);
  });

  it("neither spends the sign-off nor asks the founder for a turn that has ended", async () => {
    const { asked, decide } = signedFor();
    expect(await decide(AbortSignal.abort())).toEqual({ allow: false });
    expect(asked).toEqual([]);
    expect(store.consumeApproval("deploy", "git push")).toBe(true);
  });
});
