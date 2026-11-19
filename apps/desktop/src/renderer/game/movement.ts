import type { Dir } from "@repo/domain/character-frame";
import { nodeCenter, tileOf, walkableNode } from "@/renderer/game/office-grid";
import type { WalkGrid } from "@/renderer/game/office-grid";
import type { PixelPoint } from "@/renderer/game/office-layout-schema";

/** The way a character faces to travel (dx, dy). Ties go sideways; no travel faces the room. */
export const facingToward = (dx: number, dy: number) => {
  if (dx !== 0 && Math.abs(dx) >= Math.abs(dy)) {
    return (dx < 0 ? "left" : "right") satisfies Dir;
  }

  return (dy < 0 ? "up" : "down") satisfies Dir;
};

type Step =
  | { readonly kind: "arrive" }
  | { readonly kind: "advance"; readonly dx: number; readonly dy: number; readonly facing: Dir };

export const stepToward = (from: PixelPoint, to: PixelPoint, reach: number) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);

  if (dist <= reach) {
    return { kind: "arrive" } satisfies Step;
  }

  return {
    dx: (dx / dist) * reach,
    dy: (dy / dist) * reach,
    facing: facingToward(dx, dy),
    kind: "advance",
  } satisfies Step;
};

const RANDOM_FLOOR_TRIES = 24;

/**
 * Somewhere walkable within `radius` px of `at`, by rejection sampling — or null when
 * the tries run out, so a wanderer boxed in by furniture simply stays put.
 */
export const randomFloor = (
  grid: WalkGrid,
  at: PixelPoint,
  radius: number,
  random: () => number = Math.random,
) => {
  for (let i = 0; i < RANDOM_FLOOR_TRIES; i += 1) {
    const tile = tileOf(at.x + (random() * 2 - 1) * radius, at.y + (random() * 2 - 1) * radius);

    if (walkableNode(grid, tile)) {
      return nodeCenter(tile);
    }
  }

  return null;
};
