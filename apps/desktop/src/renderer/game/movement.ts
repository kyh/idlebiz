// Walking, one frame at a time, as pure math: which way a mover faces, how far it
// gets this frame, and where an idle one might wander off to. The player and the
// NPCs both step through here so they walk — and face — the same way.
import type { Dir } from "@/shared/character-frame";
import { nodeCenter, tileOf, walkableNode, type WalkGrid } from "@/shared/office-grid";
import type { PixelPoint } from "@/shared/office-layout-schema";

/** The way a character faces to travel (dx, dy). Ties go sideways; no travel faces the room. */
export function facingToward(dx: number, dy: number): Dir {
  if (dx !== 0 && Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "up" : "down";
}

/** One frame of travel toward a waypoint: land on it, or close `reach` px of the gap. */
export type Step =
  | { readonly kind: "arrive" }
  | { readonly kind: "advance"; readonly dx: number; readonly dy: number; readonly facing: Dir };

export function stepToward(from: PixelPoint, to: PixelPoint, reach: number): Step {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= reach) return { kind: "arrive" };
  return {
    kind: "advance",
    dx: (dx / dist) * reach,
    dy: (dy / dist) * reach,
    facing: facingToward(dx, dy),
  };
}

const RANDOM_FLOOR_TRIES = 24;

/**
 * Somewhere walkable within `radius` px of `at`, by rejection sampling — or null when
 * the tries run out, so a wanderer boxed in by furniture simply stays put.
 */
export function randomFloor(
  grid: WalkGrid,
  at: PixelPoint,
  radius: number,
  random: () => number = Math.random,
): PixelPoint | null {
  for (let i = 0; i < RANDOM_FLOOR_TRIES; i++) {
    const tile = tileOf(at.x + (random() * 2 - 1) * radius, at.y + (random() * 2 - 1) * radius);
    if (walkableNode(grid, tile)) return nodeCenter(tile);
  }
  return null;
}
