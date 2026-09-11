import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readJsonlSince, readJsonlTail } from "./fs";

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

describe("JSONL since", () => {
  const Stamped = z.object({ createdAt: z.number(), value: z.number() });

  it("returns the rows after the moment, and knows it reached it", () => {
    writeFileSync(
      file,
      '{"createdAt":1,"value":1}\n{"createdAt":5,"value":2}\n{"createdAt":9,"value":3}\n',
    );

    expect(readJsonlSince(file, Stamped, 5)).toEqual({
      complete: true,
      rows: [{ createdAt: 9, value: 3 }],
    });
    expect(readJsonlSince(file, Stamped, 0).rows).toHaveLength(3);
  });

  it("reports a floor when the byte cap cut the read before the moment", () => {
    const oversized = JSON.stringify({ createdAt: 1, padding: "x".repeat(1024 * 1024), value: 1 });
    writeFileSync(file, `${oversized}\n{"createdAt":7,"value":2}\n`);

    expect(readJsonlSince(file, Stamped, 3)).toEqual({
      complete: false,
      rows: [{ createdAt: 7, value: 2 }],
    });
  });

  it("is complete on a missing log", () => {
    expect(readJsonlSince(path.join(root, "none.jsonl"), Stamped, 0)).toEqual({
      complete: true,
      rows: [],
    });
  });
});
