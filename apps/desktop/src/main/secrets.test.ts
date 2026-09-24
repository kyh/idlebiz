import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

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
const { checkSecrets, deleteSecret, getSecret, setSecret } = await import("./secrets");

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
