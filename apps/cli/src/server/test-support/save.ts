import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach } from "vitest";
import type { Company } from "@repo/domain/domain";
import type { RunnerId } from "@repo/domain/runners";
import { openSave } from "../paths";
import * as store from "../store/store";
import type { FoundingHire } from "../store/store";

// What the save's tests share: a root of the test file's own, and Kai's Acme founded on it. A
// test file calls tempSave or freshSave at its top; a path read before either throws, never
// reaching the founder's save.

/** Opens a save root of the calling test file's own for each of its tests, deleted after its last. */
export const tempSave = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "idlebiz-test-"));
  openSave(root);
  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
  });
  return root;
};

/** `tempSave`, emptied and booted before each test, so each starts on a save with no company. */
export const freshSave = (): string => {
  const root = tempSave();
  beforeEach(() => {
    rmSync(root, { force: true, recursive: true });
    store.initStore();
  });
  return root;
};

/** A hire as founding takes one: an engineer who ships, on claude unless `runner` says otherwise. */
export const hire = (name: string, title = "Engineer", runner: RunnerId = "claude") =>
  ({ name, persona: "ships", role: "engineer", runner, spriteSeed: name, title }) as const;

type Founding = Parameters<typeof store.foundCompany>[0];

/**
 * Kai founds Acme on the open save with `team`: a software company out to ship, spending without
 * a cap, unless `over` says otherwise.
 */
export const foundAcme = (
  team: readonly FoundingHire[] = [],
  over: Partial<Omit<Founding, "hires">> = {},
): Company =>
  store.foundCompany({
    budget: { mode: "infinite" },
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    mission: "ship",
    name: "Acme",
    ...over,
    hires: team,
  });
