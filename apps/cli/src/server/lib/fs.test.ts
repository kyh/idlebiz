import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { atomicWrite, readJsonFileForUpdate, readJsonlTail } from "./fs";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-jsonl-"));
const file = path.join(root, "activity.jsonl");
const RowSchema = z.object({ value: z.number() });

afterAll(() => rmSync(root, { force: true, recursive: true }));

describe("JSONL tail", () => {
  it.each(["", "\n"])("reads the requested rows with final separator %j", (separator) => {
    writeFileSync(file, `{"value":1}\n{"value":2}\n{"value":3}${separator}`);

    expect(readJsonlTail(file, RowSchema, 1)).toEqual([{ value: 3 }]);
    expect(readJsonlTail(file, RowSchema, 2)).toEqual([{ value: 2 }, { value: 3 }]);
  });

  it.each([0, -1])("returns no rows for limit %i", (limit) => {
    writeFileSync(file, '{"value":1}\n');

    expect(readJsonlTail(file, RowSchema, limit)).toEqual([]);
  });

  it("skips malformed JSON and rows rejected by the schema", () => {
    writeFileSync(file, '{"value":1}\nnot-json\n{"value":"invalid"}\n{"value":2}\n');

    expect(readJsonlTail(file, RowSchema, 4)).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it("drops the partial first line when a log exceeds the byte cap", () => {
    const oversized = JSON.stringify({ padding: "x".repeat(1024 * 1024), value: 1 });
    writeFileSync(file, `${oversized}\n{"value":2}\n{"value":3}\n`);

    expect(readJsonlTail(file, RowSchema, 10)).toEqual([{ value: 2 }, { value: 3 }]);
  });
});

describe("JSON file read for an update", () => {
  const json = path.join(root, "config.json");

  it("is null only when the file does not exist", () => {
    rmSync(json, { force: true });

    expect(readJsonFileForUpdate(json, RowSchema)).toBeNull();
  });

  it("reads a file the schema accepts", () => {
    writeFileSync(json, '{"value":1}');

    expect(readJsonFileForUpdate(json, RowSchema)).toEqual({ value: 1 });
  });

  it.each(['{"value":1,}', '{"value":"one"}'])(
    "refuses %j rather than reading it as empty",
    (text) => {
      writeFileSync(json, text);

      expect(() => readJsonFileForUpdate(json, RowSchema)).toThrow(`IdleBiz can't read ${json}`);
    },
  );
});

describe("atomicWrite", () => {
  const secrets = path.join(root, "secrets.json");
  const leak = path.join(root, "leak");

  it.each([
    ["a symlink", symlinkSync],
    ["a hard link", linkSync],
  ] as const)("never writes through %s planted as its tmp", (_kind, plantLink) => {
    rmSync(`${secrets}.tmp`, { force: true });
    writeFileSync(leak, "");
    plantLink(leak, `${secrets}.tmp`);

    atomicWrite(secrets, "CANARY-NEW-KEY", { mode: 0o600 });

    expect(readFileSync(leak, "utf-8")).toBe("");
    expect(readFileSync(secrets, "utf-8")).toBe("CANARY-NEW-KEY");
    expect(existsSync(`${secrets}.tmp`)).toBe(false);
  });

  it("gives the file its mode over a tmp a crash left with another", () => {
    writeFileSync(`${secrets}.tmp`, "stale", { mode: 0o644 });

    atomicWrite(secrets, "{}", { mode: 0o600 });

    expect(statSync(secrets).mode.toString(8)).toMatch(/600$/u);
  });
});
