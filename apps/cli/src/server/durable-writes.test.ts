import type * as NodeFs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWrite } from "./lib/fs";
import { savePrintfulToken } from "./printful-token";
import { setSecret } from "./secrets";
import * as store from "./store/store";
import { foundAcme, freshSave } from "./test-support/save";

// No crash can be staged here, so what makes a write durable is held by its order instead: the
// file is flushed before the rename that gives it its name.

/** What reached the disk, in order: each flush, and the name each rename gave. */
const disk = vi.hoisted((): string[] => []);

// oxlint-disable-next-line anti-slop/no-module-mocking -- a spy, not a fake: each call goes to the real fs, and the order is all a flush shows short of a crash
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return {
    ...fs,
    fsyncSync: (fd: number): void => {
      disk.push("flush");
      fs.fsyncSync(fd);
    },
    renameSync: (from: NodeFs.PathLike, to: NodeFs.PathLike): void => {
      disk.push(`name ${path.basename(String(to))}`);
      fs.renameSync(from, to);
    },
  };
});

const root = freshSave();

/** Whether every write that named `name` was flushed first. */
const flushedBefore = (name: string): boolean => {
  const named = disk.flatMap((step, at) => (step === `name ${name}` ? [at] : []));
  return named.length > 0 && named.every((at) => disk[at - 1] === "flush");
};

beforeEach(() => {
  disk.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("atomicWrite", () => {
  it("flushes a durable file before it takes its name, and no other", () => {
    atomicWrite(path.join(root, "durable.json"), "{}", { durable: true });
    atomicWrite(path.join(root, "plain.json"), "{}");

    expect(disk).toEqual(["flush", "name durable.json", "name plain.json"]);
  });
});

describe("what the founder would lose to an OS crash", () => {
  it("is flushed before it takes its name: founding's files, COMPANY.md, the sign-offs", () => {
    foundAcme();
    const founded = disk.indexOf("name company");
    const staged = disk.slice(0, founded).filter((step) => step.startsWith("name "));

    expect(staged.length).toBeGreaterThan(1);
    expect(staged.every((step) => flushedBefore(step.slice("name ".length)))).toBe(true);

    store.setAutopilot(false);
    store.grantApproval("task-1", "deploy");

    expect(flushedBefore("COMPANY.md")).toBe(true);
    expect(flushedBefore("approvals.json")).toBe(true);
  });

  it("is flushed before it takes its name: the keys, and the Printful store its token sells with", async () => {
    vi.stubGlobal("fetch", (url: string) =>
      Promise.resolve(
        Response.json(
          url.endsWith("/v2/oauth-scopes")
            ? { data: [{ name: "View and manage orders", value: "orders" }] }
            : { data: [{ id: 42, name: "Acme Prints", type: "native" }] },
        ),
      ),
    );
    setSecret("VERCEL_TOKEN", "vercel-token");
    await savePrintfulToken("pf_founder_token_0000000000abcd");

    expect(flushedBefore("secrets.json")).toBe(true);
    expect(flushedBefore("printful-store.json")).toBe(true);
  });
});
