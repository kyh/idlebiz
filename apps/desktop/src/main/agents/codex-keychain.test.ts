import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexLoginInKeychain } from "./codex-keychain";

describe("codexLoginInKeychain", () => {
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "idlebiz-codex-home-"));
  });
  afterEach(() => {
    rmSync(home, { force: true, recursive: true });
  });
  const inKeychain = (config: string | null): Promise<boolean> => {
    if (config !== null) {
      writeFileSync(path.join(home, "config.toml"), config);
    }
    return codexLoginInKeychain({ CODEX_HOME: home });
  };

  it.each([
    [null, false],
    ['model = "gpt-5"', false],
    ['cli_auth_credentials_store = "file"', false],
    ['cli_auth_credentials_store = "keyring"', true],
    ["cli_auth_credentials_store = 'auto'", true],
    ['profile = "work"\n[profiles.work]\ncli_auth_credentials_store = "keyring"', true],
    [
      'cli_auth_credentials_store = "keyring"\nprofile = "work"\n[profiles.work]\ncli_auth_credentials_store = "file"',
      false,
    ],
    ['[profiles.work]\ncli_auth_credentials_store = "keyring"', false],
    ["cli_auth_credentials_store = ", false],
  ])("reads %j as a login in the Keychain: %s", async (config, expected) => {
    expect(await inKeychain(config)).toBe(expected);
  });
});
