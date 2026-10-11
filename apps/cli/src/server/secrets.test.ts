import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonRecordSchema, parseJson } from "@repo/domain/json";
import type { JsonRecord } from "@repo/domain/json";
import type { Sealer } from "./secrets";
import { tempSave } from "./test-support/save";
import {
  checkSecrets,
  deleteSecret,
  getSecret,
  hasSecret,
  sealerFor,
  sealingKeySchema,
  secretsUnder,
  setSealer,
  setSecret,
} from "./secrets";

const secretsFile = path.join(tempSave(), "secrets.json");
const previous = {
  PRINTFUL_TOKEN: process.env.PRINTFUL_TOKEN,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  VERCEL_TOKEN: process.env.VERCEL_TOKEN,
};

const raw = (): JsonRecord => jsonRecordSchema.parse(parseJson(readFileSync(secretsFile, "utf-8")));

/** Main's sealer over one app's Keychain key: it opens only what it sealed. */
const keychainItem = (fill: number): Sealer =>
  sealerFor(sealingKeySchema.parse(Buffer.alloc(32, fill).toString("base64")));

const SEALED_V2 = "sealed:v2:";
const NONCE_BYTES = 12;

/** A sealed value's bytes, changed by `edit` and kept again under the same name. */
const tamper = (name: string, edit: (sealed: Buffer) => void): void => {
  const file = raw();
  const value = z.string().startsWith(SEALED_V2).parse(file[name]);
  const sealed = Buffer.from(value.slice(SEALED_V2.length), "base64");
  edit(sealed);
  writeFileSync(
    secretsFile,
    JSON.stringify({ ...file, [name]: `${SEALED_V2}${sealed.toString("base64")}` }),
  );
};

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
  for (const key of ["PRINTFUL_TOKEN", "STRIPE_SECRET_KEY", "VERCEL_TOKEN"] as const) {
    restore(key);
  }
};

beforeEach(() => {
  rmSync(secretsFile, { force: true });
  restoreSecrets();
  setSealer(null);
});

afterAll(() => {
  restoreSecrets();
});

describe("a secrets.json the founder broke by hand", () => {
  const broken = '{"STRIPE_SECRET_KEY":"1",}';

  beforeEach(() => writeFileSync(secretsFile, broken));

  it("refuses to set a key over it", () => {
    expect(() => setSecret("VERCEL_TOKEN", "2")).toThrow("it will not be overwritten");
    expect(readFileSync(secretsFile, "utf-8")).toBe(broken);
    expect(process.env.VERCEL_TOKEN).toBe(previous.VERCEL_TOKEN);
  });

  it("refuses to delete a key from it", () => {
    expect(() => deleteSecret("STRIPE_SECRET_KEY")).toThrow("it will not be overwritten");
    expect(readFileSync(secretsFile, "utf-8")).toBe(broken);
  });

  it("is reported at boot and left as the founder wrote it", () => {
    const failure = checkSecrets();
    expect(failure?.file).toBe(secretsFile);
    expect(failure?.cause).toBeInstanceOf(Error);
    expect(readFileSync(secretsFile, "utf-8")).toBe(broken);
    expect(getSecret("STRIPE_SECRET_KEY")).toBeNull();
  });

  it("is not rewritten to seal the key in it", () => {
    setSealer(keychainItem(7));
    expect(checkSecrets()?.file).toBe(secretsFile);
    expect(getSecret("STRIPE_SECRET_KEY")).toBeNull();
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
    writeFileSync(secretsFile, '{"STRIPE_SECRET_KEY":"1"}');

    setSecret("VERCEL_TOKEN", "2");
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("1");
    expect(getSecret("VERCEL_TOKEN")).toBe("2");

    deleteSecret("VERCEL_TOKEN");
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("1");
    expect(getSecret("VERCEL_TOKEN")).toBeNull();
  });

  it("reads only a name IdleBiz holds or set_env kept", () => {
    writeFileSync(secretsFile, '{"VERCEL_TOKEN":"1"}');
    // @ts-expect-error -- a misspelt name reads as no key, so it must not compile
    expect(getSecret("VERCEL_TOKN")).toBeNull();
    expect(getSecret("ENV/acme/site/prj_1/DATABASE_URL")).toBeNull();
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
    process.env.PRINTFUL_TOKEN = "from the shell";
    writeFileSync(secretsFile, '{"PRINTFUL_TOKEN":"1"}');

    deleteSecret("PRINTFUL_TOKEN");
    expect(getSecret("PRINTFUL_TOKEN")).toBeNull();
    expect(process.env.PRINTFUL_TOKEN).toBe("from the shell");
  });
});

describe("keys sealed with the Keychain", () => {
  beforeEach(() => setSealer(keychainItem(7)));

  it("never holds a key as plain text, and opens it for main", () => {
    setSecret("STRIPE_SECRET_KEY", "sk_live_founder");

    expect(readFileSync(secretsFile, "utf-8")).not.toContain("sk_live_founder");
    expect(raw().STRIPE_SECRET_KEY).toMatch(/^sealed:v2:/u);
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("sk_live_founder");
    expect(statSync(secretsFile).mode.toString(8)).toMatch(/600$/u);
  });

  it("seals the same key apart each time, so two values give nothing away", () => {
    setSecret("STRIPE_SECRET_KEY", "sk_live_founder");
    const first = raw().STRIPE_SECRET_KEY;
    setSecret("STRIPE_SECRET_KEY", "sk_live_founder");

    expect(raw().STRIPE_SECRET_KEY).not.toBe(first);
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("sk_live_founder");
  });

  it("opens nothing from a value changed by a single byte, names it at boot, and leaves it be", () => {
    setSecret("STRIPE_SECRET_KEY", "sk_live_founder");
    tamper("STRIPE_SECRET_KEY", (sealed) => {
      sealed.writeUInt8((sealed.readUInt8(NONCE_BYTES) + 1) % 256, NONCE_BYTES);
    });
    const written = readFileSync(secretsFile, "utf-8");

    expect(getSecret("STRIPE_SECRET_KEY")).toBeNull();
    expect(String(checkSecrets()?.cause)).toContain("STRIPE_SECRET_KEY");
    expect(readFileSync(secretsFile, "utf-8")).toBe(written);
  });

  it("opens nothing from a value moved under another key's name", () => {
    setSecret("STRIPE_SECRET_KEY", "sk_live_founder");
    setSecret("VERCEL_TOKEN", "vercel_sealed");
    const file = raw();
    writeFileSync(
      secretsFile,
      JSON.stringify({
        STRIPE_SECRET_KEY: file.VERCEL_TOKEN,
        VERCEL_TOKEN: file.STRIPE_SECRET_KEY,
      }),
    );

    expect(getSecret("STRIPE_SECRET_KEY")).toBeNull();
    expect(getSecret("VERCEL_TOKEN")).toBeNull();
  });

  it("reads a value an older scheme sealed as one to enter again, never as pasted text", () => {
    const old = "sealed:v1:djEwc2VhbGVk";
    writeFileSync(secretsFile, JSON.stringify({ STRIPE_SECRET_KEY: old }));

    expect(getSecret("STRIPE_SECRET_KEY")).toBeNull();
    expect(hasSecret("STRIPE_SECRET_KEY")).toBe(true);
    expect(String(checkSecrets()?.cause)).toContain("Enter each again");
    expect(raw().STRIPE_SECRET_KEY).toBe(old);
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

  it("opens every key under a prefix it can, by the rest of its name, and none it can't", () => {
    setSealer(keychainItem(9));
    setSecret("ENV/acme/OLD", "sealed_elsewhere");
    setSealer(keychainItem(7));
    setSecret("ENV/acme/OPENAI_API_KEY", "sk-proj-acme");
    setSecret("ENV/beta/RESEND_API_KEY", "re_beta");
    setSecret("VERCEL_TOKEN", "vercel_sealed");

    expect(readFileSync(secretsFile, "utf-8")).not.toContain("sk-proj-acme");
    expect(secretsUnder("ENV/")).toEqual(
      new Map([
        ["acme/OPENAI_API_KEY", "sk-proj-acme"],
        ["beta/RESEND_API_KEY", "re_beta"],
      ]),
    );
    expect(hasSecret("ENV/acme/OLD")).toBe(true);
    expect(hasSecret("ENV/acme/NEVER_SET")).toBe(false);
    expect(String(checkSecrets()?.cause)).toContain(
      "Each ENV/ value is one your team set with set_env, which sets it again.",
    );
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

describe("the key main seals with", () => {
  it("is 32 bytes of base64, or the hello is refused", () => {
    expect(sealingKeySchema.safeParse(Buffer.alloc(32, 1).toString("base64")).success).toBe(true);
    expect(sealingKeySchema.safeParse(Buffer.alloc(16, 1).toString("base64")).success).toBe(false);
    expect(sealingKeySchema.safeParse("not base64").success).toBe(false);
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
