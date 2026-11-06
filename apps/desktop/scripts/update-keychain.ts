// The Keychain an update smoke runs on: a keychain of its own in scratch, first on the user's
// search list while it runs, holding IdleBiz's sealing key (src-tauri/src/keychain.rs) for both of
// its ad-hoc packs, so each reads it with no prompt, as two releases signed by one Developer ID do.
// An ad-hoc pack's code identity is its cdhash, which an update changes, so the item lets in either
// cdhash (its partition list) and either app (its access list). The user's own keychains are only
// read, and the search list is put back as it was found.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_ITEM, KEYCHAIN_SERVICE } from "./packaged-app.ts";

// the sealing key's 32 bytes, as the shell makes one
const KEY_BYTES = 32;
// the partitions `security` itself writes an item under, which it and Apple's code read with
const APPLE_PARTITIONS = ["apple-tool:", "apple:"] as const;
// a `security` call held on a prompt nobody answers
const SECURITY_TIMEOUT_MS = 10_000;

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
      `security could not ${what} (it exited ${ran.status ?? ran.signal ?? ran.error?.message}): ${ran.stderr.trim()}`,
    );
  }
  return ran.stdout;
};

const cdhashOf = (app: string): string => {
  const described = spawnSync("codesign", ["-dvvv", app], { encoding: "utf-8" });
  if (described.status !== 0) {
    throw new Error(`codesign could not describe ${app}: ${described.stderr.trim()}`);
  }
  return cdhashIn(described.stderr);
};

/** The user's keychain search list, as `security` reads it. */
const searchList = (): string[] =>
  parseSearchList(security("list the user's keychains", ["list-keychains", "-d", "user"]));

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
  /** The sealing key it holds: 32 random bytes, base64. */
  key: string;
  /** Puts the search list back as it was found and deletes the keychain; never throws. */
  restore: () => string[];
}

/**
 * A keychain in `dir`, first on the search list, holding a new sealing key that `apps` read with no
 * prompt: the installed pack, and the update it installs. The caller has refused a user's Keychain
 * that holds the item, so the shell finds this one's and makes none of its own.
 */
export const openScratchKeychain = (dir: string, apps: readonly string[]): ScratchKeychain => {
  const found = searchList();
  // `security` keeps a keychain named *.keychain as *.keychain-db, and lists it by that name
  const named = path.join(dir, "update-smoke.keychain");
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
          `${String(error)}: put back the search list with \`security list-keychains -d user -s ${found.map((each) => `"${each}"`).join(" ")}\``,
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
    const key = randomBytes(KEY_BYTES).toString("base64");
    security("add IdleBiz's sealing key to the smoke's keychain", [
      "add-generic-password",
      ...KEYCHAIN_ITEM,
      "-w",
      key,
      "-A",
      ...apps.flatMap((app) => ["-T", app]),
      file,
    ]);
    security("let both packs read the key", [
      "set-generic-password-partition-list",
      "-S",
      partitionList(apps.map(cdhashOf)),
      ...KEYCHAIN_ITEM,
      "-k",
      password,
      file,
    ]);
    setSearchList([file, ...found.filter((each) => each !== file)]);
    listed = true;
    // the item a launch's read finds first is this keychain's
    const holder = /^keychain: "(?<holder>.+)"$/mu.exec(
      security("find IdleBiz's sealing key", ["find-generic-password", ...KEYCHAIN_ITEM]),
    )?.groups?.holder;
    // as the disk names each, however `security` spells the path
    if (
      holder === undefined ||
      !existsSync(holder) ||
      realpathSync.native(holder) !== realpathSync.native(file)
    ) {
      throw new Error(
        `the search list finds "${KEYCHAIN_SERVICE}", "${KEYCHAIN_ACCOUNT}" in ${holder ?? "no keychain"}, not the smoke's ${file}`,
      );
    }
    return { file, found, key, restore };
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
