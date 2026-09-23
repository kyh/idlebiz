import { describe, expect, it } from "vitest";
import type { OfficeObjectDef } from "@/shared/office-layout-schema";
import { BUNDLED_LAYOUT, layoutOf, officeOf } from "./office-layout";

const catalogChair = {
  anchorY: 96,
  id: "office-object-235",
  layer: "object",
  x: 0,
  y: 0,
} satisfies OfficeObjectDef;
const facelessChair = {
  ...catalogChair,
  path: "workspace-kit/design2/d2-noface-office-object-235-96-64.png",
} satisfies OfficeObjectDef;

describe("office placements", () => {
  it("key a texture by the PNG it paints, so one id drawn from two files shows both", () => {
    const office = officeOf({
      ...BUNDLED_LAYOUT,
      objects: [catalogChair, facelessChair, { ...catalogChair, x: 64 }],
    });
    const [catalog, faceless, again] = office.placements;
    expect(catalog?.path).toBe("workspace-kit/office-objects/32/modern-office-32-235.png");
    expect(faceless?.path).toBe(facelessChair.path);
    expect(faceless?.key).not.toBe(catalog?.key);
    expect(again?.key).toBe(catalog?.key);
  });
});

describe("the office in force", () => {
  it("is the saved one, and the bundled one for a file this build could not read", () => {
    const saved = { ...BUNDLED_LAYOUT, spawn: { x: 1, y: 1 } };
    expect(layoutOf({ kind: "saved", layout: saved })).toBe(saved);
    expect(layoutOf({ kind: "absent" })).toBe(BUNDLED_LAYOUT);
    expect(layoutOf({ kind: "unreadable", reason: "bad" })).toBe(BUNDLED_LAYOUT);
    expect(layoutOf({ kind: "newer" })).toBe(BUNDLED_LAYOUT);
  });
});
