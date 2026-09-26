/** Opaque-pixel coverage of a sprite, in its own pixel space. */
export interface OpaqueMask {
  readonly opaque: Uint8Array;
  readonly w: number;
  readonly h: number;
}

/** Probe sprite-local pixels. Flips mirror within the canvas; off-canvas is transparent. */
export const opaqueAt = (
  mask: OpaqueMask,
  flip: { readonly flipX?: boolean; readonly flipY?: boolean },
  dx: number,
  dy: number,
): boolean => {
  if (dx < 0 || dy < 0 || dx >= mask.w || dy >= mask.h) {
    return false;
  }
  const lx = flip.flipX ? mask.w - 1 - dx : dx;
  const ly = flip.flipY ? mask.h - 1 - dy : dy;
  return mask.opaque[ly * mask.w + lx] === 1;
};
