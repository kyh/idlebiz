import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { openSave } from "../paths";
import * as store from "../store/store";
import { foundAcme, hire } from "./save";

// The save `pnpm smoke:update` installs an update over (apps/desktop/scripts/smoke-update.ts), on
// the root IDLEBIZ_SEED_ROOT names. Founding through the page needs a signed-in CLI, and the
// packaged app drops the stand-in's switches, so Kai's Acme is founded through the store, as main's
// tests found it: its cap $0 and its autopilot off, so its scheduler starts no run. Its keys are the
// smoke's scratch keychain's (update-keychain.ts). vitest.seed.config.ts alone runs this file, and
// `pnpm test`'s config, which names *.test.ts, never does.

/**
 * `root`, made, which lies in the OS's temporary folder as typed, before anything is made, and as
 * the disk resolves it after, through any link. The folder is named both ways: on macOS TMPDIR's
 * /var/folders is a link to /private/var/folders.
 */
const scratchRoot = (root: string): string => {
  const temp = realpathSync.native(tmpdir());
  const inTemp = (file: string): boolean =>
    [path.resolve(tmpdir()), temp].some((folder) => {
      const relative = path.relative(folder, file);
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    });
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

it("founds Acme on the save the update smoke installs over", () => {
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
  expect(store.getCompany()).toMatchObject({
    autopilot: false,
    budget: { capUsd: 0, mode: "capped" },
    name: "Acme",
  });
});
