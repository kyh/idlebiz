import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach } from "vitest";
import type { RunnerId } from "@repo/domain/runners";
import { openSave } from "../paths";
import * as store from "../store/store";
import type { FoundingHire } from "../store/store";

/**
 * Opens a save root of the calling test file's own for each of its tests, deleted after its last.
 * The folder is made before the first test, not when the file is collected: a file whose every
 * test skips runs no afterAll, and would leave one behind.
 */
export const tempSave = () => {
  const root = path.join(tmpdir(), `idlebiz-test-${randomUUID()}`);
  openSave(root);
  beforeAll(() => {
    mkdirSync(root);
  });
  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
  });

  return root;
};

/** `tempSave`, emptied and booted before each test, so each starts on a save with no company. */
export const freshSave = () => {
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
) =>
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
