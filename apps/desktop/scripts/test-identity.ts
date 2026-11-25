import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseSearchList } from "./update-keychain.ts";

const SECURITY_TIMEOUT_MS = 10_000;

const opensslConfig = (name: string) =>
  [
    "[req]",
    "distinguished_name = dn",
    "x509_extensions = codesign",
    "prompt = no",
    "[dn]",
    `CN = ${name}`,
    "[codesign]",
    "basicConstraints = critical, CA:false",
    "keyUsage = critical, digitalSignature",
    "extendedKeyUsage = critical, codeSigning",
    "",
  ].join("\n");

const ran = (what: string, file: string, args: readonly string[]) => {
  const result = spawnSync(file, args, { encoding: "utf-8", timeout: SECURITY_TIMEOUT_MS });

  if (result.status !== 0) {
    throw new Error(
      `${file} could not ${what} (it exited ${result.status ?? result.signal ?? result.error?.message}): ${result.stderr?.trim() ?? ""}`,
    );
  }

  return result.stdout;
};

/** The SHA-1 `openssl x509 -fingerprint -sha1` prints, as codesign takes an identity. */
export const sha1In = (printed: string) => {
  const hex = /fingerprint=(?<hex>[0-9a-f:]{59})/iu.exec(printed)?.groups?.hex;

  if (hex === undefined) {
    throw new Error(`openssl named no SHA-1 fingerprint:\n${printed}`);
  }

  return hex.replaceAll(":", "").toUpperCase();
};

/** A keychain in scratch that holds throwaway code-signing identities. */
export interface SigningKeychain {
  file: string;
  /** Makes an identity no Mac trusts, named `name`, and answers its SHA-1. */
  identity: (name: string) => string;
  /** Puts the search list back and deletes the keychain; never throws. */
  close: () => string[];
}

/**
 * A keychain in `dir`, first on the search list until `close`, for throwaway code-signing
 * identities: codesign signs with one by its SHA-1 and `--keychain`, and since macOS trusts none
 * of them, no pack they sign opens on another Mac and none passes for a release.
 */
export const openSigningKeychain = (dir: string) => {
  const named = path.join(dir, "update-smoke-signing.keychain");
  const password = randomBytes(24).toString("hex");

  const found = parseSearchList(
    ran("list the user's keychains", "security", ["list-keychains", "-d", "user"]),
  );

  ran("make the signing keychain", "security", ["create-keychain", "-p", password, named]);
  const file = [`${named}-db`, named].find((each) => existsSync(each)) ?? named;
  ran("unlock the signing keychain", "security", ["unlock-keychain", "-p", password, file]);
  ran("keep the signing keychain unlocked", "security", ["set-keychain-settings", file]);
  ran("put the signing keychain on the search list", "security", [
    "list-keychains",
    "-d",
    "user",
    "-s",
    file,
    ...found,
  ]);

  const identity = (name: string) => {
    const slug = name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
    const config = path.join(dir, `${slug}.cnf`);
    const key = path.join(dir, `${slug}.key.pem`);
    const cert = path.join(dir, `${slug}.cert.pem`);
    writeFileSync(config, opensslConfig(name));

    ran(`make ${name}`, "/usr/bin/openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-config",
      config,
      "-keyout",
      key,
      "-out",
      cert,
    ]);

    const bundle = path.join(dir, `${slug}.p12`);
    const sealed = randomBytes(12).toString("hex");

    ran(`bundle ${name}`, "/usr/bin/openssl", [
      "pkcs12",
      "-export",
      "-inkey",
      key,
      "-in",
      cert,
      "-name",
      name,
      "-keypbe",
      "PBE-SHA1-3DES",
      "-certpbe",
      "PBE-SHA1-3DES",
      "-passout",
      `pass:${sealed}`,
      "-out",
      bundle,
    ]);

    ran(`import ${name}`, "security", [
      "import",
      bundle,
      "-k",
      file,
      "-f",
      "pkcs12",
      "-P",
      sealed,
      "-T",
      "/usr/bin/codesign",
    ]);

    ran(`let codesign use ${name} with no prompt`, "security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      password,
      file,
    ]);

    return sha1In(
      ran(`read ${name}'s fingerprint`, "/usr/bin/openssl", [
        "x509",
        "-noout",
        "-fingerprint",
        "-sha1",
        "-in",
        cert,
      ]),
    );
  };

  const close = () =>
    [
      () =>
        ran("put the search list back", "security", [
          "list-keychains",
          "-d",
          "user",
          "-s",
          ...found,
        ]),
      () => ran("delete the signing keychain", "security", ["delete-keychain", file]),
    ].flatMap((undo) => {
      try {
        undo();

        return [];
      } catch (error) {
        return [String(error)];
      }
    });

  return { close, file, identity } satisfies SigningKeychain;
};

/** Signs `app` whole as the throwaway `identity` in `keychain`. */
export const signAs = (app: string, identity: string, keychain: string) => {
  ran(`sign ${app}`, "codesign", [
    "--force",
    "--deep",
    "--timestamp=none",
    "--sign",
    identity,
    "--keychain",
    keychain,
    app,
  ]);
  ran(`verify ${app}'s signature`, "codesign", ["--verify", "--deep", "--strict", app]);
};
