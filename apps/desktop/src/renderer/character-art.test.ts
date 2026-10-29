import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FRAME_H,
  FRAME_W,
  SHEET_COLUMNS,
  SIT_START,
  STRIP_FRAMES,
  WALK_START,
} from "@repo/domain/character-frame";
import { SHEET_COUNT } from "@repo/domain/character-seed";
import { bustUrl, sheetUrl } from "./character-art";

const publicDir = path.resolve(import.meta.dirname, "../../public");
const pinned = Array.from({ length: SHEET_COUNT }, (_, i) => `employee-sheet:${i + 1}`);

/** A PNG's size, from its IHDR chunk, which every PNG opens with. */
const pngSize = (url: string) => {
  const png = readFileSync(path.join(publicDir, url));
  return { height: png.readUInt32BE(20), width: png.readUInt32BE(16) };
};

describe("the bundled characters", () => {
  it("ship a sheet and a bust for every sheet a seed can wear, and nothing else", () => {
    const shipped = readdirSync(path.join(publicDir, "characters")).map((f) => `/characters/${f}`);
    const worn = pinned.flatMap((seed) => [sheetUrl(seed), bustUrl(seed)]);
    expect(shipped.toSorted()).toEqual(worn.toSorted());
  });

  it("lay every sheet out in the frames the office cuts its anims from", () => {
    const last = Math.max(...Object.values(WALK_START), ...Object.values(SIT_START)) + STRIP_FRAMES;
    const rows = Math.ceil(last / SHEET_COLUMNS);
    for (const seed of pinned) {
      const { height, width } = pngSize(sheetUrl(seed));
      expect(width).toBe(SHEET_COLUMNS * FRAME_W);
      expect(height).toBeGreaterThanOrEqual(rows * FRAME_H);
    }
  });
});
