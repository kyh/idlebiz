import type Phaser from "phaser";
import type { OpaqueMask } from "@/shared/office-sight";

export type { OpaqueMask };

function opaqueMaskOf(
  source: ReturnType<Phaser.Textures.Texture["getSourceImage"]>,
): OpaqueMask | null {
  if (!(source instanceof HTMLImageElement) && !(source instanceof HTMLCanvasElement)) return null;
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const opaque = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < opaque.length; i++) opaque[i] = (pixels[i * 4 + 3] ?? 0) > 0 ? 1 : 0;
  return { opaque, w: canvas.width, h: canvas.height };
}

/**
 * Opaque-pixel coverage of loaded textures, each read back at most once. Reading a
 * texture means a canvas round trip, so callers ask only when bounds already meet.
 */
export function textureMasks(
  textures: Phaser.Textures.TextureManager,
): (key: string) => OpaqueMask | null {
  const masks = new Map<string, OpaqueMask | null>();
  return (key) => {
    const cached = masks.get(key);
    if (cached !== undefined) return cached;
    const mask = opaqueMaskOf(textures.get(key).getSourceImage());
    masks.set(key, mask);
    return mask;
  };
}

/** One frame of a sheet as its own mask: the standing pose the sight pass judges by. */
export function frameMask(
  sheet: OpaqueMask,
  frame: { x: number; y: number; w: number; h: number },
): OpaqueMask {
  const opaque = new Uint8Array(frame.w * frame.h);
  for (let y = 0; y < frame.h; y++) {
    for (let x = 0; x < frame.w; x++) {
      opaque[y * frame.w + x] = sheet.opaque[(frame.y + y) * sheet.w + frame.x + x] ?? 0;
    }
  }
  return { opaque, w: frame.w, h: frame.h };
}
