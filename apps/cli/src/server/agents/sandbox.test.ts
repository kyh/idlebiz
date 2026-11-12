import { describe, expect, it } from "vitest";
import type { LoadReport } from "@repo/domain/domain";
import { notingSandbox } from "./sandbox";

describe("notingSandbox", () => {
  const report: LoadReport = {
    skipped: [
      { error: "bad yaml", kind: "task", newerBuild: false, path: "/save/tasks/x/TASK.md" },
    ],
  };

  it("tells the founder beside the save's notes why no run starts", () => {
    expect(notingSandbox(report, "sandbox-exec timed out, so none will start.")).toEqual({
      skipped: [
        ...report.skipped,
        {
          error: "sandbox-exec timed out, so none will start.",
          kind: "sandbox",
          newerBuild: false,
          path: "/usr/bin/sandbox-exec",
        },
      ],
    });
  });

  it("adds nothing while runs start sandboxed", () => {
    expect(notingSandbox(report, null)).toBe(report);
  });
});
