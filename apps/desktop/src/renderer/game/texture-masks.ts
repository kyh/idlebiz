import type Phaser from "phaser";
import { opaqueMask } from "@/shared/office-sight";
import type { OpaqueMask } from "@/shared/office-sight";

export { type OpaqueMask } from "@/shared/office-sight";

const opaqueMaskOf = (
  source: ReturnType<Phaser.Textures.Texture["getSourceImage"]>,
): OpaqueMask | null => {
  if (!(source instanceof HTMLImageElement) && !(source instanceof HTMLCanvasElement)) {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.drawImage(source, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return opaqueMask({ data, h: canvas.height, w: canvas.width });
};

/**
 * Opaque-pixel coverage of loaded textures, each read back at most once. Reading a
 * texture means a canvas round trip, so callers ask only when bounds already meet.
 */
export const textureMasks = (
  textures: Phaser.Textures.TextureManager,
): ((key: string) => OpaqueMask | null) => {
  const masks = new Map<string, OpaqueMask | null>();
  return (key) => {
    const cached = masks.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const mask = opaqueMaskOf(textures.get(key).getSourceImage());
    masks.set(key, mask);
    return mask;
  };
};
