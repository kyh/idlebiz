import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefusalError } from "../refusal";
import { tempSave } from "../test-support/save";
import { fileVault, keychainVault } from "../test-support/vault";
import {
  clearVault,
  deleteSecret,
  getSecret,
  hasSecret,
  heldKeyIn,
  secretsUnder,
  setSecret,
  vaultFile,
} from "./vault";

tempSave();

beforeEach(() => {
  rmSync(vaultFile(), { force: true });
  fileVault();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a development launch's vault.json", () => {
  it("is seeded at boot when missing, readable by the founder alone, saying the keys stay with IdleBiz", () => {
    expect(readFileSync(vaultFile(), "utf-8")).toContain("never given to your employees");
    expect(statSync(vaultFile()).mode.toString(8).slice(-3)).toBe("600");
  });

  it("keeps the other keys and the notes when one is set or deleted", async () => {
    writeFileSync(vaultFile(), '{"STRIPE_SECRET_KEY":"1","_readme":"mine"}');

    await setSecret("VERCEL_TOKEN", "2");
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("1");
    expect(getSecret("VERCEL_TOKEN")).toBe("2");

    await deleteSecret("VERCEL_TOKEN");
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("1");
    expect(getSecret("VERCEL_TOKEN")).toBeNull();
    expect(readFileSync(vaultFile(), "utf-8")).toContain('"_readme": "mine"');
  });

  it("uses a key pasted into it at once", () => {
    writeFileSync(vaultFile(), '{"VERCEL_TOKEN":"pasted"}');
    expect(getSecret("VERCEL_TOKEN")).toBe("pasted");
  });

  it("forgets a key set blank", async () => {
    await setSecret("VERCEL_TOKEN", "2");
    await setSecret("VERCEL_TOKEN", "");
    expect(getSecret("VERCEL_TOKEN")).toBeNull();
    expect(hasSecret("VERCEL_TOKEN")).toBe(false);
  });

  it("reads only a name IdleBiz holds or set_env kept", () => {
    writeFileSync(vaultFile(), '{"VERCEL_TOKEN":"1","ENV/acme/site/DATABASE_URL":"postgres://x"}');
    // @ts-expect-error -- a misspelt name reads as no key, so it must not compile
    expect(getSecret("VERCEL_TOKN")).toBeNull();
    expect(secretsUnder("ENV/acme/")).toEqual(new Map([["site/DATABASE_URL", "postgres://x"]]));
  });

  it("keeps every key out of this process's env, and so every run's", async () => {
    vi.stubEnv("PRINTFUL_TOKEN", "from the shell");
    const before = process.env.VERCEL_TOKEN;

    await setSecret("VERCEL_TOKEN", "saved");
    await deleteSecret("PRINTFUL_TOKEN");

    expect(process.env.VERCEL_TOKEN).toBe(before);
    expect(process.env.PRINTFUL_TOKEN).toBe("from the shell");
  });

  describe("broken by hand", () => {
    const broken = '{"STRIPE_SECRET_KEY":"1",}';

    beforeEach(() => {
      writeFileSync(vaultFile(), broken);
    });

    it("is reported at boot and left as the founder wrote it", () => {
      expect(fileVault()?.where).toBe(vaultFile());
      expect(getSecret("STRIPE_SECRET_KEY")).toBeNull();
      expect(readFileSync(vaultFile(), "utf-8")).toBe(broken);
    });

    it("refuses a change over it, as a sentence", async () => {
      await expect(setSecret("VERCEL_TOKEN", "2")).rejects.toThrow(RefusalError);
      await expect(deleteSecret("STRIPE_SECRET_KEY")).rejects.toThrow("it will not be overwritten");
      expect(readFileSync(vaultFile(), "utf-8")).toBe(broken);
    });
  });
});

describe("a packaged launch's Keychain", () => {
  it("reads the keys the shell read at hello, and none of a dev file", () => {
    writeFileSync(vaultFile(), '{"VERCEL_TOKEN":"from the file"}');
    keychainVault({ keys: { STRIPE_SECRET_KEY: "sk_live_founder1234" } });

    expect(getSecret("STRIPE_SECRET_KEY")).toBe("sk_live_founder1234");
    expect(getSecret("VERCEL_TOKEN")).toBeNull();
  });

  it("asks the shell to keep each change, and holds it once kept", async () => {
    const { calls } = keychainVault({ keys: { VERCEL_TOKEN: "old_token_0000" } });

    await setSecret("STRIPE_SECRET_KEY", "sk_live_founder1234");
    await setSecret("VERCEL_TOKEN", "");

    expect(calls).toEqual([
      ["STRIPE_SECRET_KEY", "sk_live_founder1234"],
      ["VERCEL_TOKEN", null],
    ]);
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("sk_live_founder1234");
    expect(getSecret("VERCEL_TOKEN")).toBeNull();
    expect(existsSync(vaultFile())).toBe(true);
    expect(readFileSync(vaultFile(), "utf-8")).not.toContain("sk_live_founder1234");
  });

  it("keeps what it held when the Keychain refuses a change, saying why", async () => {
    keychainVault({
      keys: { VERCEL_TOKEN: "old_token_0000" },
      refusing: "User interaction is not allowed.",
    });

    const setting = setSecret("VERCEL_TOKEN", "new_token_0000");

    await expect(setting).rejects.toThrow(RefusalError);
    await expect(setting).rejects.toThrow(
      "IdleBiz could not keep VERCEL_TOKEN: User interaction is not allowed.",
    );
    expect(getSecret("VERCEL_TOKEN")).toBe("old_token_0000");
  });

  it("names a key it would not give, which still counts as held until replaced", async () => {
    const { problem } = keychainVault({ refused: ["STRIPE_SECRET_KEY", "SOMETHING_ELSE"] });

    expect(problem?.cause.message).toBe(
      "The Keychain would not give IdleBiz STRIPE_SECRET_KEY. Enter each again in the app.",
    );
    expect(getSecret("STRIPE_SECRET_KEY")).toBeNull();
    expect(hasSecret("STRIPE_SECRET_KEY")).toBe(true);

    await setSecret("STRIPE_SECRET_KEY", "sk_live_again5678");
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("sk_live_again5678");
  });

  it("says so when the Keychain would not list its keys at all", () => {
    expect(keychainVault({ listed: false }).problem?.cause.message).toContain(
      "The Keychain would not list IdleBiz's keys",
    );
    expect(getSecret("STRIPE_SECRET_KEY")).toBeNull();
  });

  it("forgets every key on a reset, a refused one too", async () => {
    const { calls } = keychainVault({
      keys: { "ENV/acme/site/DATABASE_URL": "postgres://x", VERCEL_TOKEN: "old_token_0000" },
      refused: ["STRIPE_SECRET_KEY"],
    });

    await clearVault();

    expect(calls.map(([name]) => name).toSorted()).toEqual([
      "ENV/acme/site/DATABASE_URL",
      "STRIPE_SECRET_KEY",
      "VERCEL_TOKEN",
    ]);
    expect(hasSecret("STRIPE_SECRET_KEY")).toBe(false);
    expect(heldKeyIn("old_token_0000")).toBeNull();
  });
});
