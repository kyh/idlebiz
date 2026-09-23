import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { SOURCE_STANDING_FRAME, WALK_STANDING_FRAME } from "@/shared/character-frame";
import { opaqueMask, standingSilhouette } from "@/shared/office-sight";
import type { OpaqueMask } from "@/shared/office-sight";
import { buildWalkSheet } from "./compositor";

const decode = async (png: string | Buffer): Promise<OpaqueMask> => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return opaqueMask({ data, h: info.height, w: info.width });
};

describe("the walk sheet", () => {
  it("stands the character in the pose main judges sight by", async () => {
    const source = path.resolve(
      import.meta.dirname,
      "../../../resources/employee-sheets/employee-sheet-01.png",
    );
    const judged = standingSilhouette(await decode(source), SOURCE_STANDING_FRAME);
    const drawn = standingSilhouette(
      await decode(await buildWalkSheet(source)),
      WALK_STANDING_FRAME,
    );
    expect(judged.opaque).toContain(1);
    expect(judged).toEqual(drawn);
  });
});
