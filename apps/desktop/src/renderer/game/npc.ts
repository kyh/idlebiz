// One employee in the office and what they do on their own: walk a planned path, show
// what npc-look decides, sit down, sort among the furniture. The roster, the seating and
// the door they share with everyone else are npcs.ts's.
import type Phaser from "phaser";
import { idleFrame, SEAT_CROP } from "@/renderer/game/character-sheet";
import type { CharacterAnims, Dir } from "@/renderer/game/character-sheet";
import { stepToward } from "@/renderer/game/movement";
import type { NpcAttachments } from "@/renderer/game/npc-attachments";
import { lookOf } from "@/renderer/game/npc-look";
import type { Activity, Phase } from "@/renderer/game/npc-look";
import type { PixelPoint } from "@/renderer/game/office-layout";
import { characterDepth } from "@/shared/office-depth";
import { findPath, nearestFloor } from "@/shared/office-grid";
import type { WalkGrid } from "@/shared/office-grid";

/** A desk seat (px) an employee occupies. Owned by the office scene, sized to the active tier. */
export interface Seat {
  readonly x: number;
  readonly y: number;
  /** Depth its occupant renders at while seated — above the workstation, so the chair
   *  back doesn't swallow them. Computed by seat-depth.ts from the built room. */
  readonly depth: number;
}

interface WalkPlan {
  path: PixelPoint[];
  onArrive?: () => void;
}

export interface Npc {
  id: string;
  key: string;
  anims: CharacterAnims;
  sprite: Phaser.GameObjects.Sprite;
  attachments: NpcAttachments;
  /** Their workstation, or null when the office has run out of desks. */
  seat: Seat | null;
  phase: Phase;
  activity: Activity;
  /** They asked the founder something this run — "!" until the run settles. */
  asking: boolean;
  plan: WalkPlan | null;
  nextWanderAt: number;
  pendingTimer?: Phaser.Time.TimerEvent;
}

/** px/s */
const NPC_SPEED = 64;

const setDepthIfChanged = (sprite: Phaser.GameObjects.Sprite, depth: number): void => {
  if (sprite.depth !== depth) {
    sprite.setDepth(depth);
  }
};

export const clearPending = (npc: Npc): void => {
  npc.pendingTimer?.remove();
  npc.pendingTimer = undefined;
};

export const atSeat = (npc: Npc): boolean => {
  const { seat } = npc;
  return seat !== null && Math.hypot(npc.sprite.x - seat.x, npc.sprite.y - seat.y) < 4;
};

export const standFacing = (npc: Npc, dir: Dir): void => {
  npc.sprite.anims.stop();
  npc.sprite.setFrame(idleFrame(dir));
};

/** Put what npc-look decides on the sprite and over their head. */
export const applyLook = (npc: Npc): void => {
  const { emote, stance } = lookOf({
    activity: npc.activity,
    asking: npc.asking,
    atDesk: atSeat(npc),
    phase: npc.phase,
    walking: npc.plan !== null,
  });
  npc.attachments.showEmote(emote);
  if (stance?.kind === "typing") {
    // the sheet has no typing strip: walking in place, facing the screen, reads as typing
    npc.sprite.play(npc.anims.walk.up, true);
  } else if (stance) {
    standFacing(npc, stance.facing);
  }
};

/** The chair is solid, so a walk to it ends beside it; the sitter is placed on it. */
export const sitDown = (npc: Npc): void => {
  if (npc.seat) {
    npc.sprite.setPosition(npc.seat.x, npc.seat.y);
  }
  applyLook(npc);
};

/** Set off for `to`, calling `onArrive` there; false when there is no way through. */
export const walkTo = (
  npc: Npc,
  grid: WalkGrid,
  to: PixelPoint,
  onArrive?: () => void,
): boolean => {
  const start = nearestFloor(grid, npc.sprite.x, npc.sprite.y);
  if (!start) {
    return false;
  }
  if (Math.hypot(npc.sprite.x - start.x, npc.sprite.y - start.y) > 2) {
    npc.sprite.setPosition(start.x, start.y);
  }
  const path = findPath(grid, npc.sprite, to);
  if (!path || path.length === 0) {
    return false;
  }
  // a step-away scheduled by the last arrival would replace this walk and drop its arrival
  clearPending(npc);
  npc.plan = { onArrive, path };
  return true;
};

/** One frame along the plan; the arrival hook runs once the last waypoint is reached. */
export const stepAlong = (npc: Npc, plan: WalkPlan, dt: number): void => {
  const [waypoint] = plan.path;
  if (!waypoint) {
    npc.plan = null;
    applyLook(npc);
    // an arrival pose (POI facing / sitting) overrides the default look
    plan.onArrive?.();
    return;
  }
  const step = stepToward(npc.sprite, waypoint, NPC_SPEED * dt);
  if (step.kind === "arrive") {
    npc.sprite.setPosition(waypoint.x, waypoint.y);
    plan.path.shift();
    return;
  }
  npc.sprite.x += step.dx;
  npc.sprite.y += step.dy;
  npc.sprite.play(npc.anims.walk[step.facing], true);
};

/**
 * Seated employees are drawn as a bust lifted above their workstation — the pack paints
 * its seated workers over the chair with the desk in front, which y-sorting alone can't
 * do (a chair's floor contact is south of its occupant, so it would hide them). Walkers
 * y-sort normally, on their soles.
 */
export const applyDepth = (npc: Npc): void => {
  const { seat } = npc;
  if (!npc.plan && npc.phase === "settled" && seat && atSeat(npc)) {
    if (!npc.sprite.isCropped) {
      npc.sprite.setCrop(SEAT_CROP.x, SEAT_CROP.y, SEAT_CROP.w, SEAT_CROP.h);
    }
    setDepthIfChanged(npc.sprite, seat.depth);
    return;
  }
  if (npc.sprite.isCropped) {
    npc.sprite.setCrop();
  }
  setDepthIfChanged(npc.sprite, characterDepth(npc.sprite.y));
};
