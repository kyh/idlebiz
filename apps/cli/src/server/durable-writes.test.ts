import * as fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWrite } from "./lib/fs";
import { savePrintfulToken } from "./printful-token";
import { setSecret } from "./vault/vault";
import * as store from "./store/store";
import { foundAcme, freshSave } from "./test-support/save";
import { answerFetch, interceptNetwork } from "./test-support/network";

interceptNetwork();

// oxlint-disable-next-line anti-slop/no-module-mocking -- a spy, not a fake: each call goes to the real fs, and the order is all a flush shows short of a crash
vi.mock("node:fs", { spy: true });

const disk = () =>
  [
    ...vi.mocked(fs.fsyncSync).mock.invocationCallOrder.map((at) => ({ at, step: "flush" })),
    ...vi.mocked(fs.renameSync).mock.calls.map(([, to], i) => ({
      at: vi.mocked(fs.renameSync).mock.invocationCallOrder[i] ?? 0,
      step: `name ${path.basename(String(to))}`,
    })),
  ]
    .toSorted((a, b) => a.at - b.at)
    .map(({ step }) => step);

const root = freshSave();

const flushedBefore = (name: string) => {
  const steps = disk();
  const named = steps.flatMap((step, at) => (step === `name ${name}` ? [at] : []));

  return named.length > 0 && named.every((at) => steps[at - 1] === "flush");
};

beforeEach(() => {
  vi.mocked(fs.fsyncSync).mockClear();
  vi.mocked(fs.renameSync).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("atomicWrite", () => {
  it("flushes a durable file before it takes its name, and no other", () => {
    atomicWrite(path.join(root, "durable.json"), "{}", { durable: true });
    atomicWrite(path.join(root, "plain.json"), "{}");

    expect(disk()).toEqual(["flush", "name durable.json", "name plain.json"]);
  });
});

describe("what the founder would lose to an OS crash", () => {
  it("is flushed before it takes its name: founding's files, COMPANY.md, the sign-offs", () => {
    foundAcme();
    const steps = disk();
    const founded = steps.indexOf("name company");
    const staged = steps.slice(0, founded).filter((step) => step.startsWith("name "));

    expect(staged.length).toBeGreaterThan(1);
    expect(staged.every((step) => flushedBefore(step.slice("name ".length)))).toBe(true);

    store.setAutopilot(false);
    store.grantApproval("task-1", "deploy");

    expect(flushedBefore("COMPANY.md")).toBe(true);
    expect(flushedBefore("approvals.json")).toBe(true);
  });

  it("is flushed before it takes its name: the keys, and the Printful store its token sells with", async () => {
    answerFetch((url: string) =>
      Promise.resolve(
        Response.json(
          url.endsWith("/v2/oauth-scopes")
            ? { data: [{ name: "View and manage orders", value: "orders" }] }
            : { data: [{ id: 42, name: "Acme Prints", type: "native" }] },
        ),
      ),
    );
    await setSecret("VERCEL_TOKEN", "vercel-token");
    await savePrintfulToken("pf_founder_token_0000000000abcd");

    expect(flushedBefore("vault.json")).toBe(true);
    expect(flushedBefore("printful-store.json")).toBe(true);
  });
});
