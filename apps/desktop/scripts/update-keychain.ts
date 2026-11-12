// The Keychain an update smoke runs on: a keychain of its own in scratch, first on the user's
// search list while it runs, holding one key of IdleBiz's vault (src-tauri/src/vault.rs) for both
// of its ad-hoc packs, so each reads it with no prompt, as two releases signed by one Developer ID do.
// An ad-hoc pack's code identity is its cdhash, which an update changes, so the item lets in either
// cdhash (its partition list) and either app (its access list). The user's own keychains are only
// read, and the search list is put back as it was found, or named for the next run to refuse when a
// run is killed outright.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { KEYCHAIN_SERVICE, holdsVaultItem } from "./packaged-app.ts";

// a value a team set, which main holds only to refuse a deploy carrying it and never sends a vendor
const CANARY_ACCOUNT = "ENV/smoke/smoke/UPDATE_SMOKE";
const CANARY_ITEM = ["-s", KEYCHAIN_SERVICE, "-a", CANARY_ACCOUNT] as const;
// the partitions `security` itself writes an item under, which it and Apple's code read with
const APPLE_PARTITIONS = ["apple-tool:", "apple:"] as const;
// a `security` call held on a prompt nobody answers
const SECURITY_TIMEOUT_MS = 10_000;
// the smoke's keychain in its scratch, which `security` keeps as *.keychain-db
const KEYCHAIN_NAME = "update-smoke.keychain";

/** The keychains `security list-keychains` prints, one quoted path a line. */
export const parseSearchList = (listed: string): string[] =>
  listed.split("\n").flatMap((line) => {
    const file = /^\s*"(?<file>.+)"\s*$/u.exec(line)?.groups?.file;
    return file === undefined ? [] : [file];
  });

/** The cdhash `codesign -dvvv` names, which is an ad-hoc app's code identity. */
export const cdhashIn = (described: string): string => {
  const cdhash = /^CDHash=(?<cdhash>[0-9a-f]{40,64})$/mu.exec(described)?.groups?.cdhash;
  if (cdhash === undefined) {
    throw new Error(`codesign named no CDHash:\n${described}`);
  }
  return cdhash;
};

/** What an item's partition list holds for apps of `cdhashes` to read it with no prompt. */
export const partitionList = (cdhashes: readonly string[]): string =>
  [...APPLE_PARTITIONS, ...cdhashes.map((cdhash) => `cdhash:${cdhash}`)].join(",");

const security = (what: string, args: readonly string[]): string => {
  const ran = spawnSync("security", args, { encoding: "utf-8", timeout: SECURITY_TIMEOUT_MS });
  if (ran.status !== 0) {
    throw new Error(
      `security could not ${what} (it exited ${ran.status ?? ran.signal ?? ran.error?.message}): ${ran.stderr?.trim() ?? ""}`,
    );
  }
  return ran.stdout;
};

const cdhashOf = (app: string): string => {
  const described = spawnSync("codesign", ["-dvvv", app], { encoding: "utf-8" });
  if (described.status !== 0) {
    throw new Error(`codesign could not describe ${app}: ${described.stderr?.trim() ?? ""}`);
  }
  return cdhashIn(described.stderr);
};

/** The user's keychain search list, as `security` reads it. */
const searchList = (): string[] =>
  parseSearchList(security("list the user's keychains", ["list-keychains", "-d", "user"]));

/** The command that sets the user's search list to `keychains`, for a sentence to name. */
const setListCommand = (keychains: readonly string[]): string =>
  `security list-keychains -d user -s ${keychains.map((each) => `"${each}"`).join(" ")}`;

const setSearchList = (keychains: readonly string[]): void => {
  security("set the user's keychain search list", [
    "list-keychains",
    "-d",
    "user",
    "-s",
    ...keychains,
  ]);
};

export interface ScratchKeychain {
  /** The keychain's file, in scratch. */
  file: string;
  /** The search list as the smoke found it, which `restore` puts back. */
  found: readonly string[];
  /** Puts the search list back as it was found and deletes the keychain; never throws. */
  restore: () => string[];
}

/**
 * Refuses a search list a smoke killed outright left its keychain on, whose key a later look would
 * take for the user's own, naming the command that takes it off.
 */
export const refuseKilledSmokesKeychain = (): void => {
  const listed = searchList();
  const left = listed.filter((file) =>
    [KEYCHAIN_NAME, `${KEYCHAIN_NAME}-db`].includes(path.basename(file)),
  );
  if (left.length > 0) {
    throw new Error(
      `a smoke killed before it ended left ${left.join(", ")} on the user's keychain search list: take it off with \`${setListCommand(listed.filter((file) => !left.includes(file)))}\` and delete it`,
    );
  }
};

/**
 * A keychain in `dir`, first on the search list, holding one key of the vault's that `apps` read with
 * no prompt: the installed pack, and the update it installs. It refuses where the user's own
 * keychains hold any of IdleBiz's keys, as it starts and once its own is first: a founder's, which a
 * pack would wait on a prompt to read, and so a key found there as the smoke ends is one a launch
 * wrote, entering none.
 */
export const openScratchKeychain = (dir: string, apps: readonly string[]): ScratchKeychain => {
  const found = searchList();
  // a key there is a founder's: no smoke's to sit beside, nor to delete as it ends
  const userHoldsKey = (): boolean => found.length > 0 && holdsVaultItem(found);
  const held = `the user's Keychain holds IdleBiz's keys ("${KEYCHAIN_SERVICE}"): a founder's, which the smoke neither sits beside nor deletes, so smoke on a Mac without them`;
  if (userHoldsKey()) {
    throw new Error(held);
  }
  // `security` keeps a keychain named *.keychain as *.keychain-db, and lists it by that name
  const named = path.join(dir, KEYCHAIN_NAME);
  let file = named;
  const password = randomBytes(24).toString("hex");
  let created = false;
  let listed = false;
  const restore = (): string[] => {
    const failures: string[] = [];
    if (listed) {
      try {
        setSearchList(found);
        listed = false;
      } catch (error) {
        failures.push(
          `${String(error)}: put back the search list with \`${setListCommand(found)}\``,
        );
      }
    }
    if (created) {
      try {
        security("delete the smoke's keychain", ["delete-keychain", file]);
        created = false;
      } catch (error) {
        failures.push(String(error));
      }
    }
    return failures;
  };
  try {
    security("make the smoke's keychain", ["create-keychain", "-p", password, named]);
    created = true;
    file = [`${named}-db`, named].find((each) => existsSync(each)) ?? named;
    // no lock after a timeout or on sleep, which a long pack would outlast
    security("keep the smoke's keychain unlocked", ["set-keychain-settings", file]);
    security("unlock the smoke's keychain", ["unlock-keychain", "-p", password, file]);
    security("add a key of IdleBiz's to the smoke's keychain", [
      "add-generic-password",
      ...CANARY_ITEM,
      "-w",
      randomBytes(16).toString("hex"),
      "-A",
      ...apps.flatMap((app) => ["-T", app]),
      file,
    ]);
    security("let both packs read the key", [
      "set-generic-password-partition-list",
      "-S",
      partitionList(apps.map(cdhashOf)),
      ...CANARY_ITEM,
      "-k",
      password,
      file,
    ]);
    setSearchList([file, ...found.filter((each) => each !== file)]);
    listed = true;
    // the item a launch's read finds first is this keychain's
    const holder = /^keychain: "(?<holder>.+)"$/mu.exec(
      security("find IdleBiz's key", ["find-generic-password", ...CANARY_ITEM]),
    )?.groups?.holder;
    // as the disk names each, however `security` spells the path
    if (
      holder === undefined ||
      !existsSync(holder) ||
      realpathSync.native(holder) !== realpathSync.native(file)
    ) {
      throw new Error(
        `the search list finds "${KEYCHAIN_SERVICE}", "${CANARY_ACCOUNT}" in ${holder ?? "no keychain"}, not the smoke's ${file}`,
      );
    }
    // one made between the first look and the list's change: from here a launch finds this one's
    if (userHoldsKey()) {
      throw new Error(held);
    }
    return { file, found, restore };
  } catch (error) {
    const failures = restore();
    if (failures.length > 0) {
      throw new Error(`${String(error)}\nand undoing it failed:\n  ${failures.join("\n  ")}`, {
        cause: error,
      });
    }
    throw error;
  }
};
