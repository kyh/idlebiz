import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-secrets-"));
const secretsFile = path.join(root, "secrets.json");
const previous = {
  A: process.env["A"],
  B: process.env["B"],
  IDLEBIZ_ROOT_DIR: process.env["IDLEBIZ_ROOT_DIR"],
};
process.env["IDLEBIZ_ROOT_DIR"] = root;
const { deleteSecret, exportSecretsToEnv, getSecret, setSecret } = await import("./secrets");

const restore = (key: keyof typeof previous): void => {
  const value = previous[key];
  if (value === undefined) {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stringifies an assigned undefined; delete is the only unset
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

beforeEach(() => {
  rmSync(secretsFile, { force: true });
  restore("A");
  restore("B");
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  restore("A");
  restore("B");
  restore("IDLEBIZ_ROOT_DIR");
});

describe("a secrets.json the founder broke by hand", () => {
  const broken = '{"A":"1",}';

  beforeEach(() => writeFileSync(secretsFile, broken));

  it("refuses to set a key over it", () => {
    expect(() => setSecret("B", "2")).toThrow("it will not be overwritten");
    expect(readFileSync(secretsFile, "utf-8")).toBe(broken);
    expect(process.env["B"]).toBe(previous.B);
  });

  it("refuses to delete a key from it", () => {
    expect(() => deleteSecret("A")).toThrow("it will not be overwritten");
    expect(readFileSync(secretsFile, "utf-8")).toBe(broken);
  });

  it("is reported at boot instead of exporting nothing silently", () => {
    expect(exportSecretsToEnv()).toEqual({ cause: expect.any(Error), file: secretsFile });
    expect(readFileSync(secretsFile, "utf-8")).toBe(broken);
    expect(getSecret("A")).toBeNull();
  });
});

describe("a readable secrets.json", () => {
  it("is seeded at boot when missing", () => {
    expect(exportSecretsToEnv()).toBeNull();
    expect(existsSync(secretsFile)).toBe(true);
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

  it("exports its string keys at boot", () => {
    writeFileSync(secretsFile, '{"A":"1","_readme":"docs"}');

    expect(exportSecretsToEnv()).toBeNull();
    expect(process.env["A"]).toBe("1");
  });
});
