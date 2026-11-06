import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { openSave } from "../paths";
import { ENV_PREFIX, secretsPath } from "../secrets";
import * as store from "../store/store";
import { foundAcme, hire } from "./save";

// The save `pnpm smoke:update` installs an update over (apps/desktop/scripts/smoke-update.ts), on
// the root IDLEBIZ_SEED_ROOT names. Founding through the page needs a signed-in CLI, and the
// packaged app drops the stand-in's switches, so Kai's Acme is founded through the store, as main's
// tests found it: its cap $0 and its autopilot off, so its scheduler starts no run. secrets.json
// holds one value pasted as plain text, a team's value main never sends a vendor, which the
// installed app seals with its Keychain key as it boots. vitest.seed.config.ts alone runs this
// file, and `pnpm test`'s config, which names *.test.ts, never does.

// a value the smoke reads back, so its name is the smoke's to find: the one ENV/ key in the file
const CANARY = "UPDATE_SMOKE";

/**
 * `root`, made, which lies in the OS's temporary folder as typed, before anything is made, and as
 * the disk resolves it after, through any link.
 */
const scratchRoot = (root: string): string => {
  const temp = realpathSync.native(tmpdir());
  const inTemp = (file: string): boolean => {
    const relative = path.relative(temp, file);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  const refusal = `the update smoke's save lies in the OS's temporary folder (${temp}), never a founder's: ${root}`;
  if (!inTemp(path.resolve(root))) {
    throw new Error(refusal);
  }
  mkdirSync(root, { recursive: true });
  const real = realpathSync.native(root);
  if (!inTemp(real)) {
    throw new Error(refusal);
  }
  return real;
};

test("founds Acme on the save the update smoke installs over", () => {
  const root = process.env.IDLEBIZ_SEED_ROOT;
  if (root === undefined || root === "") {
    throw new Error(
      "IDLEBIZ_SEED_ROOT names no save: the update smoke seeds one it made in scratch (apps/desktop/scripts/smoke-update.ts)",
    );
  }
  openSave(scratchRoot(root));
  store.initStore();
  foundAcme([hire("Ada")], { budget: { capUsd: 0, mode: "capped" } });
  store.setAutopilot(false);
  const [product] = store.listProducts();
  if (product === undefined) {
    throw new Error("Acme was founded with no product to keep a team's value for");
  }
  // `wx`: a secrets.json already there is someone's keys, never overwritten
  writeFileSync(
    secretsPath(),
    `${JSON.stringify({ [`${ENV_PREFIX}${product.id}/${product.id}/${CANARY}`]: randomBytes(16).toString("hex") }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  expect(store.getCompany()).toMatchObject({
    autopilot: false,
    budget: { capUsd: 0, mode: "capped" },
    name: "Acme",
  });
});
