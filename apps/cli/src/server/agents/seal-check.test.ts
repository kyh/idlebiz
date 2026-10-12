import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LoadReport } from "@repo/domain/domain";
import { readBack } from "../test-support/sealed-command";
import { SEAL } from "./fixtures";
import { checkSeal, notingSeal } from "./seal-check";

describe("notingSeal", () => {
  const report: LoadReport = {
    skipped: [
      { error: "bad yaml", kind: "task", newerBuild: false, path: "/save/tasks/x/TASK.md" },
    ],
  };

  it("tells the founder beside the save's notes why no run starts", () => {
    expect(notingSeal(report, "sandbox-exec timed out, so none will start.")).toEqual({
      skipped: [
        ...report.skipped,
        {
          error: "sandbox-exec timed out, so none will start.",
          kind: "seal",
          newerBuild: false,
          path: "/usr/bin/sandbox-exec",
        },
      ],
    });
  });

  it("adds nothing while runs start sealed", () => {
    expect(notingSeal(report, null)).toBe(report);
  });
});

describe("checkSeal", () => {
  it("runs each runner's runtime under the profile against canaries where no rule lets it write, never the real keys", async () => {
    const seen: { argv: readonly string[]; env: Record<string, string> }[] = [];
    const refusal = await checkSeal(SEAL, (argv, env) => {
      seen.push({ argv, env });
      return Promise.resolve(0);
    });
    expect(refusal).toBeNull();
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
    [null, "could not run macOS's sandbox-exec"],
    [3, "let a run read a file it seals"],
    [5, "let a run write outside its own folders"],
    [71, "(exit 71)"],
  ])("refuses every run when a probe ends %s", async (code, sentence) => {
    const refusal = await checkSeal(SEAL, (argv) =>
      Promise.resolve(argv.some((word) => word.endsWith("written-by-codex")) ? code : 0),
    );
    expect(refusal).toContain(sentence);
  });
});
