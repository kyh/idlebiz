import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { FRAME_H, FRAME_W, SOURCE_STANDING_FRAME } from "@repo/domain/character-frame";
import { buildWalkSheet } from "./compositor";

const frame = (png: string | Buffer, at: { x: number; y: number }): Promise<Buffer> =>
  sharp(png)
    .extract({ height: FRAME_H, left: at.x, top: at.y, width: FRAME_W })
    .ensureAlpha()
    .raw()
    .toBuffer();

describe("the walk sheet", () => {
  it("opens on the standing pose, walk-down's first frame", async () => {
    const source = path.resolve(
      import.meta.dirname,
      "../../../resources/employee-sheets/employee-sheet-01.png",
    );
    const standing = await frame(source, SOURCE_STANDING_FRAME);
    expect(standing.some((byte) => byte > 0)).toBe(true);
    expect(await frame(await buildWalkSheet(source), { x: 0, y: 0 })).toEqual(standing);
  });
});
