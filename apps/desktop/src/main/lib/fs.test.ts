import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readJsonlTail } from "./fs";

const root = mkdtempSync(join(tmpdir(), "idlebiz-jsonl-"));
const file = join(root, "activity.jsonl");
const RowSchema = z.object({ value: z.number() });

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("JSONL tail", () => {
  it.each(["", "\n"])("reads the requested rows with final separator %j", (separator) => {
    writeFileSync(file, '{"value":1}\n{"value":2}\n{"value":3}' + separator);

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
    const oversized = JSON.stringify({ value: 1, padding: "x".repeat(1024 * 1024) });
    writeFileSync(file, oversized + '\n{"value":2}\n{"value":3}\n');

    expect(readJsonlTail(file, RowSchema, 10)).toEqual([{ value: 2 }, { value: 3 }]);
  });
});
