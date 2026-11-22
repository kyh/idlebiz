import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJson } from "@repo/domain/json";

const versionOf = (packageDir: string) =>
  z
    .object({ version: z.string() })
    .parse(parseJson(readFileSync(path.join(packageDir, "package.json"), "utf-8"))).version;

describe("the release's version", () => {
  it("is the same in the app and the server it ships", () => {
    const desktop = path.resolve(import.meta.dirname, "..");
    expect(versionOf(path.resolve(desktop, "..", "cli"))).toBe(versionOf(desktop));
  });
});
