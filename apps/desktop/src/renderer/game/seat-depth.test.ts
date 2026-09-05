import { describe, expect, it } from "vitest";
import { BUST, characterDepth } from "./character-sheet";
import { DEPTH } from "@/shared/office-depth";
import { bustOverlapRect, bustOverlaps, seatDepth, type RoomImage } from "./seat-depth";
import type { OpaqueMask } from "@/shared/office-sight";

// A seat at (100, 100): the bust spans x 90..110 and y 62..100 (height 38 above the origin).
const seat = { x: 100, y: 100 };

function image(overrides: Partial<RoomImage> = {}): RoomImage {
  return {
    x: 80,
    y: 40,
    width: 40,
    height: 80,
    depth: 0,
    flipX: false,
    flipY: false,
    ...overrides,
  };
}

/** A w×h mask with one opaque pixel at (px, py) in texture space. */
function dotMask(w: number, h: number, px: number, py: number): OpaqueMask {
  const opaque = new Uint8Array(w * h);
  opaque[py * w + px] = 1;
  return { opaque, w, h };
}
const clear = (w: number, h: number): OpaqueMask => ({ opaque: new Uint8Array(w * h), w, h });
const solid = (w: number, h: number): OpaqueMask => ({
  opaque: new Uint8Array(w * h).fill(1),
  w,
  h,
});

describe("bustOverlapRect", () => {
  it("is the bust clipped to the image bounds, in whole pixels", () => {
    expect(bustOverlapRect(seat, image())).toEqual({ x0: 90, y0: 62, x1: 110, y1: 100 });
    expect(bustOverlapRect(seat, image({ x: 105, width: 20 }))).toEqual({
      x0: 105,
      y0: 62,
      x1: 110,
      y1: 100,
    });
    expect(bustOverlapRect(seat, image({ height: 30 }))).toEqual({
      x0: 90,
      y0: 62,
      x1: 110,
      y1: 70,
    });
  });

  it("is null when the bounds do not meet", () => {
    expect(bustOverlapRect(seat, image({ x: 110 }))).toBeNull(); // starts where the bust ends
    expect(bustOverlapRect(seat, image({ y: 100 }))).toBeNull(); // below the origin row
    expect(bustOverlapRect(seat, image({ x: 0, width: 50 }))).toBeNull();
  });

  it("cuts from the bust silhouette the sheet was measured for", () => {
    expect(BUST).toEqual({ halfWidth: 10, height: 38 });
  });
});

describe("bustOverlaps", () => {
  it("never reads a texture whose bounds miss the bust", () => {
    let reads = 0;
    const miss = image({ x: 200 });
    expect(
      bustOverlaps(seat, miss, () => {
        reads += 1;
        return solid(40, 80);
      }),
    ).toBe(false);
    expect(reads).toBe(0);
  });

  it("treats an unreadable texture as covering", () => {
    expect(bustOverlaps(seat, image(), () => null)).toBe(true);
  });

  it("looks for an opaque pixel inside the overlap, not just anywhere on the canvas", () => {
    // image at (80, 40): the bust covers texture x 10..30, y 22..60
    expect(bustOverlaps(seat, image(), () => dotMask(40, 80, 15, 30))).toBe(true);
    expect(bustOverlaps(seat, image(), () => dotMask(40, 80, 2, 30))).toBe(false); // left of the bust
    expect(bustOverlaps(seat, image(), () => dotMask(40, 80, 15, 70))).toBe(false); // below the origin
    expect(bustOverlaps(seat, image(), () => clear(40, 80))).toBe(false);
  });

  it("reads a flipped image through its flipped pixels", () => {
    // flipped horizontally, texture x 2 is drawn at world x 80 + 37 = 117 — off the bust
    expect(bustOverlaps(seat, image({ flipX: true }), () => dotMask(40, 80, 2, 30))).toBe(false);
    // ...and texture x 25 at world x 80 + 14 = 94, inside it
    expect(bustOverlaps(seat, image({ flipX: true }), () => dotMask(40, 80, 25, 30))).toBe(true);
    // flipped vertically, texture y 70 lands at world y 40 + 9 = 49 — above the bust
    expect(bustOverlaps(seat, image({ flipY: true }), () => dotMask(40, 80, 15, 70))).toBe(false);
    expect(bustOverlaps(seat, image({ flipY: true }), () => dotMask(40, 80, 15, 30))).toBe(true);
  });
});

describe("seatDepth", () => {
  const base = characterDepth(seat.y);

  it("sits just above its own floor line when nothing overlaps", () => {
    expect(seatDepth(seat, [], () => solid(1, 1))).toBeCloseTo(base + 0.25);
  });

  it("lifts to the topmost overlapping entity-band image, and no further", () => {
    const room = [
      image({ depth: base + 3 }),
      image({ depth: base + 9 }),
      image({ depth: base + 30, x: 200 }), // above, but off to the side
    ];
    expect(seatDepth(seat, room, () => solid(40, 80))).toBeCloseTo(base + 9.25);
  });

  it("ignores what is already below the sitter and everything overhead", () => {
    const room = [image({ depth: base - 1 }), image({ depth: DEPTH.overhead + 1 })];
    expect(seatDepth(seat, room, () => solid(40, 80))).toBeCloseTo(base + 0.25);
  });

  it("decodes only the textures whose bounds reach the seat", () => {
    const read: number[] = [];
    const room = [
      image({ depth: base + 1, x: 300 }),
      image({ depth: base + 2 }),
      image({ depth: base + 3, y: 200 }),
    ];
    seatDepth(seat, room, (img) => {
      read.push(img.depth);
      return solid(40, 80);
    });
    expect(read).toEqual([base + 2]);
  });
});
