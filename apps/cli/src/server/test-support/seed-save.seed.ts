import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { openSave } from "../paths";
import * as store from "../store/store";
import { foundAcme, hire } from "./save";

const scratchRoot = (root: string) => {
  const temp = realpathSync.native(tmpdir());

  const inTemp = (file: string) =>
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
