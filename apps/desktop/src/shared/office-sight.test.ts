import { describe, expect, it } from "vitest";
import { CHAR_ORIGIN_Y, FRAME_H, FRAME_W, HEAD_ROW } from "./character-frame";
import { layoutIssues, walkGridOf } from "./office-grid";
import type { OfficeLayoutData, OfficeObjectDef } from "./office-layout-schema";
import { faceCovered, hiddenNodes, opaqueMask, paintedSprites, sightIssues } from "./office-sight";
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

describe("opaqueMask", () => {
  it("reads the fourth byte of each pixel, and any alpha at all is paint", () => {
    const mask = opaqueMask({ data: [255, 255, 255, 0, 0, 0, 0, 1], h: 1, w: 2 });
    expect([...mask.opaque]).toEqual([0, 1]);
  });
});

describe("paintedSprites", () => {
  it("pairs every object with its PNG's mask, decoding each PNG once", async () => {
    const objects: OfficeObjectDef[] = [
      { id: "office-object-001", layer: "floor", x: 0, y: 0 },
      { id: "office-object-002", layer: "floor", x: 32, y: 0 },
      { id: "office-object-001", layer: "floor", x: 64, y: 0 },
    ];
    const decoded: string[] = [];
    const sprites = await paintedSprites({ objects }, (spritePath) => {
      decoded.push(spritePath);
      return Promise.resolve(filled(1, 1));
    });
    expect(sprites.map((sprite) => sprite.obj)).toEqual(objects);
    expect(decoded).toEqual([
      "workspace-kit/office-objects/32/modern-office-32-001.png",
      "workspace-kit/office-objects/32/modern-office-32-002.png",
    ]);
  });
});

// A 20x6 office of 16px cells: a west room (cols 1-4) and an east room (cols 15-18)
// joined only by a one-cell corridor along row 3.
const corridor = (objects: OfficeObjectDef[]): OfficeLayoutData => ({
  cell: 16,
  collision: [
    "11111111111111111111",
    "10000111111111100001",
    "10000111111111100001",
    "10000000000000000001",
    "10000111111111100001",
    "11111111111111111111",
  ],
  cols: 20,
  door: { x: 24, y: 24 },
  height: 96,
  objects,
  pois: [],
  rows: 6,
  seats: [{ role: "work", x: 280, y: 24 }],
  spawn: { x: 24, y: 24 },
  tile: 32,
  version: 2,
  width: 320,
});
/** An opaque 32px square drawn over everyone. */
const tile = (x: number, y: number): OfficeObjectDef => ({ id: "tile", layer: "overhead", x, y });
/** Where a layout of opaque 32px squares hides a face, and what closing those spots cuts off. */
const judge = (layout: OfficeLayoutData) => {
  const sprites = layout.objects.map((obj) => ({ mask: filled(32, 32), obj }));
  return {
    hidden: hiddenNodes(walkGridOf(layout), layout.spawn, sprites, silhouette),
    issues: sightIssues(layout, sprites, silhouette),
  };
};

describe("sightIssues", () => {
  it("names a seat whose only way in passes behind something that hides a face", () => {
    // over the corridor's middle: the faces at x 152 and 168 are three-quarters covered
    const layout = corridor([tile(144, 16)]);
    expect(layoutIssues(layout)).toEqual([]);
    expect(judge(layout).issues).toEqual([
      "seat 0 (work at 280,24) is unreachable from spawn once the spots where furniture hides a face are closed",
    ]);
  });

  it("names the seat when the spot closed is at its room's doorway, a few nodes from the reachable side", () => {
    // hides the faces at x 216 and 232; the corridor at 184 is within a seat's snap of it
    const layout = corridor([tile(208, 16)]);
    expect(layoutIssues(layout)).toEqual([]);
    expect(judge(layout).issues).toEqual([
      "seat 0 (work at 280,24) is unreachable from spawn once the spots where furniture hides a face are closed",
    ]);
  });

  it("lets a hidden spot be closed when every place is still reachable around it", () => {
    // over the west room's south-west corner, away from the corridor
    const { hidden, issues } = judge(corridor([tile(8, 36)]));
    expect(hidden.map((h) => h.node)).toEqual([{ x: 24, y: 72 }]);
    expect(issues).toEqual([]);
  });
});
