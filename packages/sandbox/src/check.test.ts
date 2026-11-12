import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkSandbox } from "./check";
import { SANDBOX } from "./fixture";
import { readBack } from "./read-back";

describe("checkSandbox", () => {
  it("runs each runner's runtime under the profile against canaries where no rule lets it write, never the real keys", async () => {
    const seen: { argv: readonly string[]; env: Record<string, string> }[] = [];
    const check = await checkSandbox(SANDBOX, (argv, env) => {
      seen.push({ argv, env });
      return Promise.resolve(0);
    });
    expect(check).toEqual({ kind: "holds" });
    expect(seen).toHaveLength(2);
    for (const { argv, env } of seen) {
      const { allowed, denied, runs } = readBack(argv);
      const [canary = "", written = ""] = runs.slice(-2);
      expect(canary).not.toBe("/Users/me/.idlebiz/secrets.json");
      expect(denied("file-read* file-write*")).toContain(canary);
      expect(denied("file-read* file-write*")).toContain("/Users/me/.idlebiz/secrets.json");
      expect(path.dirname(written)).toBe(path.dirname(canary));
      expect(allowed("file-write*")).not.toContain("/private/tmp");
      expect(runs[0]).toBe(process.execPath);
      expect(env).toEqual({});
      expect(existsSync(canary)).toBe(false);
    }
  });

  it.each([
    [null, { kind: "unavailable" }],
    [3, { kind: "read-unreadable" }],
    [5, { kind: "wrote-outside" }],
    [71, { code: 71, kind: "failed" }],
  ])("finds the sandbox broken when a probe ends %s", async (code, check) => {
    expect(
      await checkSandbox(SANDBOX, (argv) =>
        Promise.resolve(argv.some((word) => word.endsWith("written-by-codex")) ? code : 0),
      ),
    ).toEqual(check);
  });
});
