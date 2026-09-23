import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { BlockedAsk } from "@/shared/domain";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-driver-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const store = await import("@/main/store/store");
const { decidePermission, outcomeOf } = await import("./agent-driver");

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

describe("decidePermission", () => {
  const push = { tool: { command: "git push", kind: "shell" } } as const;

  /** A company whose founder signed for one `git push` on task "deploy". */
  const signedFor = () => {
    const company = store.foundCompany({
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
    store.grantApproval("deploy", "git push");
    const asked: BlockedAsk[] = [];
    const decide = (signal: AbortSignal) =>
      decidePermission(
        { companyId: company.id, id: "deploy" },
        push,
        new Set(),
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

  it("neither spends the sign-off nor asks the founder for a turn that has ended", async () => {
    const { asked, decide } = signedFor();
    expect(await decide(AbortSignal.abort())).toEqual({ allow: false });
    expect(asked).toEqual([]);
    expect(store.consumeApproval("deploy", "git push")).toBe(true);
  });
});
