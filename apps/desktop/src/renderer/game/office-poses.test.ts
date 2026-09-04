import { describe, expect, it } from "vitest";
import { DEFAULT_WORK_POSE, poseForToolKind } from "./office-poses";

describe("poseForToolKind", () => {
  it("reads for the kinds that only look", () => {
    expect(poseForToolKind("read")).toBe("reading");
    expect(poseForToolKind("search")).toBe("reading");
    expect(poseForToolKind("fetch")).toBe("reading");
  });

  it("types for the kinds that change something or run something", () => {
    for (const kind of ["edit", "delete", "move", "execute", "switch_mode", "other"]) {
      expect(poseForToolKind(kind), kind).toBe("typing");
    }
  });

  it("thinks for think", () => {
    expect(poseForToolKind("think")).toBe("thinking");
  });

  it("falls back to the default when the agent gave no kind", () => {
    expect(poseForToolKind(undefined)).toBe(DEFAULT_WORK_POSE);
    expect(poseForToolKind("")).toBe(DEFAULT_WORK_POSE);
    expect(poseForToolKind("Read src/app.ts")).toBe(DEFAULT_WORK_POSE); // a title, not a kind
  });
});
