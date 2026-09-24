import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { jsonRecordSchema, parseJson } from "@/shared/json";
import type { JsonRecord } from "@/shared/json";
import type { Sealer } from "./secrets";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-secrets-"));
const secretsFile = path.join(root, "secrets.json");
const previous = {
  A: process.env.A,
  B: process.env.B,
  IDLEBIZ_ROOT_DIR: process.env.IDLEBIZ_ROOT_DIR,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  VERCEL_TOKEN: process.env.VERCEL_TOKEN,
};
process.env.IDLEBIZ_ROOT_DIR = root;
const { checkSecrets, deleteSecret, getSecret, setSealer, setSecret } = await import("./secrets");

const raw = (): JsonRecord => jsonRecordSchema.parse(parseJson(readFileSync(secretsFile, "utf-8")));

/** A stand-in for one app's Keychain item: it opens only what it sealed, as safeStorage does. */
const keychainItem = (id: number): Sealer => ({
  open: (sealed) => {
    if (sealed[0] !== id) {
      throw new Error(
        "Error while decrypting the ciphertext provided to safeStorage.decryptString.",
      );
    }
    return Buffer.from(sealed.subarray(1).toReversed()).toString("utf-8");
  },
  seal: (plain) => Buffer.concat([Buffer.of(id), Buffer.from(plain, "utf-8").toReversed()]),
});

const restore = (key: keyof typeof previous): void => {
  const value = previous[key];
  if (value === undefined) {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stringifies an assigned undefined; delete is the only unset
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

const restoreSecrets = (): void => {
  for (const key of ["A", "B", "STRIPE_SECRET_KEY", "VERCEL_TOKEN"] as const) {
    restore(key);
  }
};

beforeEach(() => {
  rmSync(secretsFile, { force: true });
  restoreSecrets();
  setSealer(null);
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  restoreSecrets();
  restore("IDLEBIZ_ROOT_DIR");
});

describe("a secrets.json the founder broke by hand", () => {
  const broken = '{"A":"1",}';

  beforeEach(() => writeFileSync(secretsFile, broken));

  it("refuses to set a key over it", () => {
    expect(() => setSecret("B", "2")).toThrow("it will not be overwritten");
    expect(readFileSync(secretsFile, "utf-8")).toBe(broken);
    expect(process.env.B).toBe(previous.B);
  });

  it("refuses to delete a key from it", () => {
    expect(() => deleteSecret("A")).toThrow("it will not be overwritten");
    expect(readFileSync(secretsFile, "utf-8")).toBe(broken);
  });

  it("is reported at boot and left as the founder wrote it", () => {
    const failure = checkSecrets();
    expect(failure?.file).toBe(secretsFile);
    expect(failure?.cause).toBeInstanceOf(Error);
    expect(readFileSync(secretsFile, "utf-8")).toBe(broken);
    expect(getSecret("A")).toBeNull();
  });

  it("is not rewritten to seal the key in it", () => {
    setSealer(keychainItem(7));
    expect(checkSecrets()?.file).toBe(secretsFile);
    expect(getSecret("A")).toBeNull();
    expect(readFileSync(secretsFile, "utf-8")).toBe(broken);
  });
});

describe("a readable secrets.json", () => {
  it("is seeded at boot when missing, saying the keys stay with IdleBiz", () => {
    expect(checkSecrets()).toBeNull();
    expect(existsSync(secretsFile)).toBe(true);
    expect(readFileSync(secretsFile, "utf-8")).toContain("never given to your employees");
  });

  it("keeps the other keys when one is set or deleted", () => {
    writeFileSync(secretsFile, '{"A":"1"}');

    setSecret("B", "2");
    expect(getSecret("A")).toBe("1");
    expect(getSecret("B")).toBe("2");

    deleteSecret("B");
    expect(getSecret("A")).toBe("1");
    expect(getSecret("B")).toBeNull();
  });

  it("keeps every key in the file, out of this process's env and so every run's", () => {
    writeFileSync(secretsFile, '{"STRIPE_SECRET_KEY":"own","_readme":"docs"}');

    expect(checkSecrets()).toBeNull();
    expect(process.env.STRIPE_SECRET_KEY).toBe(previous.STRIPE_SECRET_KEY);

    setSecret("VERCEL_TOKEN", "saved");
    expect(getSecret("VERCEL_TOKEN")).toBe("saved");
    expect(process.env.VERCEL_TOKEN).toBe(previous.VERCEL_TOKEN);
  });

  it("leaves the founder's own variable of the same name alone when a key is deleted", () => {
    process.env.A = "from the shell";
    writeFileSync(secretsFile, '{"A":"1"}');

    deleteSecret("A");
    expect(getSecret("A")).toBeNull();
    expect(process.env.A).toBe("from the shell");
  });
});

describe("keys sealed with the Keychain", () => {
  beforeEach(() => setSealer(keychainItem(7)));

  it("never holds a key as plain text, and opens it for main", () => {
    setSecret("STRIPE_SECRET_KEY", "sk_live_founder");

    expect(readFileSync(secretsFile, "utf-8")).not.toContain("sk_live_founder");
    expect(raw().STRIPE_SECRET_KEY).toMatch(/^sealed:v1:/u);
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("sk_live_founder");
    expect(statSync(secretsFile).mode.toString(8)).toMatch(/600$/u);
  });

  it("seals a key pasted by hand the next time it is read, and still returns it", () => {
    writeFileSync(secretsFile, '{"_readme":"docs","VERCEL_TOKEN":"vercel_pasted"}');

    expect(getSecret("VERCEL_TOKEN")).toBe("vercel_pasted");
    expect(readFileSync(secretsFile, "utf-8")).not.toContain("vercel_pasted");
    expect(raw()._readme).toBe("docs");
    expect(getSecret("VERCEL_TOKEN")).toBe("vercel_pasted");
  });

  it("seals a pasted key at boot too", () => {
    writeFileSync(secretsFile, '{"VERCEL_TOKEN":"vercel_pasted"}');

    expect(checkSecrets()).toBeNull();
    expect(readFileSync(secretsFile, "utf-8")).not.toContain("vercel_pasted");
    expect(getSecret("VERCEL_TOKEN")).toBe("vercel_pasted");
  });

  it("reads a key another build sealed as absent, names it at boot, and leaves it be", () => {
    setSealer(keychainItem(9));
    setSecret("VERCEL_TOKEN", "vercel_other_build");
    const written = readFileSync(secretsFile, "utf-8");
    setSealer(keychainItem(7));

    expect(getSecret("VERCEL_TOKEN")).toBeNull();
    const failure = checkSecrets();
    expect(failure?.file).toBe(secretsFile);
    expect(String(failure?.cause)).toContain("VERCEL_TOKEN");
    expect(String(failure?.cause)).toContain("Enter each again");
    expect(readFileSync(secretsFile, "utf-8")).toBe(written);
  });

  it("names a sealed key at boot when the Keychain is unavailable", () => {
    setSecret("VERCEL_TOKEN", "vercel_sealed");
    setSealer(null);

    expect(getSecret("VERCEL_TOKEN")).toBeNull();
    expect(String(checkSecrets()?.cause)).toContain("isn't using the macOS Keychain");
  });

  it("keeps a key it can't open when another is set beside it", () => {
    setSealer(keychainItem(9));
    setSecret("VERCEL_TOKEN", "vercel_other_build");
    const sealedElsewhere = raw().VERCEL_TOKEN;
    setSealer(keychainItem(7));

    setSecret("STRIPE_SECRET_KEY", "sk_live_founder");
    expect(raw().VERCEL_TOKEN).toBe(sealedElsewhere);
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("sk_live_founder");
  });
});

describe("keys with no Keychain", () => {
  it("round-trips a key as plain text", () => {
    setSecret("VERCEL_TOKEN", "vercel_plain");

    expect(raw().VERCEL_TOKEN).toBe("vercel_plain");
    expect(getSecret("VERCEL_TOKEN")).toBe("vercel_plain");
    expect(checkSecrets()).toBeNull();
  });

  it("strands no key, as dev on the real save: the app's stay sealed, a new one plain for it to seal", () => {
    setSealer(keychainItem(7));
    setSecret("STRIPE_SECRET_KEY", "sk_live_founder");
    const sealedByApp = raw().STRIPE_SECRET_KEY;
    setSealer(null);

    setSecret("VERCEL_TOKEN", "vercel_from_dev");
    expect(checkSecrets()?.file).toBe(secretsFile);
    expect(getSecret("STRIPE_SECRET_KEY")).toBeNull();
    expect(raw().STRIPE_SECRET_KEY).toBe(sealedByApp);
    expect(raw().VERCEL_TOKEN).toBe("vercel_from_dev");

    setSealer(keychainItem(7));
    expect(checkSecrets()).toBeNull();
    expect(readFileSync(secretsFile, "utf-8")).not.toContain("vercel_from_dev");
    expect(getSecret("VERCEL_TOKEN")).toBe("vercel_from_dev");
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("sk_live_founder");
  });
});
