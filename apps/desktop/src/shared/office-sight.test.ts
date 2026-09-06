import { describe, expect, it } from "vitest";
import { CHAR_ORIGIN_Y, FRAME_H, FRAME_W, HEAD_ROW } from "./character-frame";
import { walkGridOf } from "./office-grid";
import type { OfficeObjectDef } from "./office-layout-schema";
import { faceCovered, hiddenNodes, type OpaqueMask } from "./office-sight";

const filled = (w: number, h: number): OpaqueMask => ({
  opaque: new Uint8Array(w * h).fill(1),
  w,
  h,
});

/** A standing character: every pixel of the frame is art, so the face is the whole band. */
const silhouette = filled(FRAME_W, FRAME_H);

// the founder stands with their origin at (40, 60): frame top at 60 - 55 = 5, face rows 23..40
const node = { x: 40, y: 60 };
const faceTop = Math.round(node.y - FRAME_H * CHAR_ORIGIN_Y) + HEAD_ROW;

/** A 32x32 sprite whose canvas sits exactly over the face rows. */
const overFace = (fields: Partial<OfficeObjectDef>): OfficeObjectDef => ({
  layer: "object",
  anchorY: 0,
  id: "thing",
  x: node.x - 16,
  y: faceTop - 8,
  ...fields,
});

describe("faceCovered", () => {
  it("counts a sprite drawn above the character as covering the face", () => {
    // floor line south of the soles (60 + 7): drawn in front of the character
    const sprites = [{ obj: overFace({ anchorY: 100 }), mask: filled(32, 32) }];
    expect(faceCovered(node, sprites, silhouette)).toBe(1);
  });

  it("ignores a sprite the character is drawn in front of", () => {
    // floor line north of the soles: the character stands south of it and covers it
    const sprites = [{ obj: overFace({ anchorY: 20 }), mask: filled(32, 32) }];
    expect(faceCovered(node, sprites, silhouette)).toBe(0);
  });

  it("always counts the overhead band and never the floor band", () => {
    const above = [{ obj: overFace({ layer: "overhead" }), mask: filled(32, 32) }];
    const below = [{ obj: overFace({ layer: "floor" }), mask: filled(32, 32) }];
    expect(faceCovered(node, above, silhouette)).toBe(1);
    expect(faceCovered(node, below, silhouette)).toBe(0);
  });

  it("reads only opaque pixels, mirrored when the sprite is flipped", () => {
    // left half opaque; flipped, that half lands on the right
    const half: OpaqueMask = { opaque: new Uint8Array(32 * 32), w: 32, h: 32 };
    for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++) half.opaque[y * 32 + x] = 1;
    const obj = overFace({ anchorY: 100, x: node.x });
    const plain = faceCovered(node, [{ obj, mask: half }], silhouette);
    const flipped = faceCovered(node, [{ obj: { ...obj, flipX: true }, mask: half }], silhouette);
    expect(plain).toBe(0.5);
    expect(flipped).toBe(0);
  });
});

describe("hiddenNodes", () => {
  it("names the reachable nodes whose face is mostly covered, worst first", () => {
    // a 6x4 room of 16px cells, open inside, with a tall object covering the top-right
    const layout = {
      cell: 16,
      cols: 6,
      rows: 4,
      width: 96,
      height: 64,
      spawn: { x: 24, y: 24 },
      seats: [],
      collision: ["111111", "100001", "100001", "111111"],
    };
    const grid = walkGridOf(layout);
    const canopy: OfficeObjectDef = {
      layer: "object",
      anchorY: 60,
      id: "canopy",
      x: 48,
      y: -40,
      flipX: false,
    };
    const hidden = hiddenNodes(
      grid,
      layout.spawn,
      [{ obj: canopy, mask: filled(48, 40) }],
      silhouette,
    );
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((h) => h.node.x >= 48)).toBe(true);
    expect(hidden[0]?.covered).toBeGreaterThanOrEqual(hidden.at(-1)?.covered ?? 0);
  });
});
