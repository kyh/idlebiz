import { describe, expect, it } from "vitest";
import { CHAR_ORIGIN_Y, FRAME_H, FRAME_W, HEAD_ROW } from "./character-frame";
import { walkGridOf } from "./office-grid";
import type { OfficeObjectDef } from "./office-layout-schema";
import { faceCovered, hiddenNodes } from "./office-sight";
import type { OpaqueMask } from "./office-sight";

const filled = (w: number, h: number): OpaqueMask => ({
  h,
  opaque: new Uint8Array(w * h).fill(1),
  w,
});

/** A standing character: every pixel of the frame is art, so the face is the whole band. */
const silhouette = filled(FRAME_W, FRAME_H);

// the founder stands with their origin at (40, 60): frame top at 60 - 55 = 5, face rows 23..40
const node = { x: 40, y: 60 };
const faceTop = Math.round(node.y - FRAME_H * CHAR_ORIGIN_Y) + HEAD_ROW;

/** A 32x32 sprite whose canvas sits exactly over the face rows. */
const overFace = (fields: Partial<OfficeObjectDef>): OfficeObjectDef => ({
  anchorY: 0,
  id: "thing",
  layer: "object",
  x: node.x - 16,
  y: faceTop - 8,
  ...fields,
});

describe("faceCovered", () => {
  it("counts a sprite drawn above the character as covering the face", () => {
    // floor line south of the soles (60 + 7): drawn in front of the character
    const sprites = [{ mask: filled(32, 32), obj: overFace({ anchorY: 100 }) }];
    expect(faceCovered(node, sprites, silhouette)).toBe(1);
  });

  it("ignores a sprite the character is drawn in front of", () => {
    // floor line north of the soles: the character stands south of it and covers it
    const sprites = [{ mask: filled(32, 32), obj: overFace({ anchorY: 20 }) }];
    expect(faceCovered(node, sprites, silhouette)).toBe(0);
  });

  it("always counts the overhead band and never the floor band", () => {
    const above = [{ mask: filled(32, 32), obj: overFace({ layer: "overhead" }) }];
    const below = [{ mask: filled(32, 32), obj: overFace({ layer: "floor" }) }];
    expect(faceCovered(node, above, silhouette)).toBe(1);
    expect(faceCovered(node, below, silhouette)).toBe(0);
  });

  it("reads only opaque pixels, mirrored when the sprite is flipped", () => {
    // left half opaque; flipped, that half lands on the right
    const half: OpaqueMask = { h: 32, opaque: new Uint8Array(32 * 32), w: 32 };
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        half.opaque[y * 32 + x] = 1;
      }
    }
    const obj = overFace({ anchorY: 100, x: node.x });
    const plain = faceCovered(node, [{ mask: half, obj }], silhouette);
    const flipped = faceCovered(node, [{ mask: half, obj: { ...obj, flipX: true } }], silhouette);
    expect(plain).toBe(0.5);
    expect(flipped).toBe(0);
  });
});

describe("hiddenNodes", () => {
  it("names the reachable nodes whose face is mostly covered, worst first", () => {
    // a 6x4 room of 16px cells, open inside, with a tall object covering the top-right
    const layout = {
      cell: 16,
      collision: ["111111", "100001", "100001", "111111"],
      cols: 6,
      height: 64,
      rows: 4,
      seats: [],
      spawn: { x: 24, y: 24 },
      width: 96,
    };
    const grid = walkGridOf(layout);
    const canopy: OfficeObjectDef = {
      anchorY: 60,
      flipX: false,
      id: "canopy",
      layer: "object",
      x: 48,
      y: -40,
    };
    const hidden = hiddenNodes(
      grid,
      layout.spawn,
      [{ mask: filled(48, 40), obj: canopy }],
      silhouette,
    );
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((h) => h.node.x >= 48)).toBe(true);
    expect(hidden[0]?.covered).toBeGreaterThanOrEqual(hidden.at(-1)?.covered ?? 0);
  });
});
