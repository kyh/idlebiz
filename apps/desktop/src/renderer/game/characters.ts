import Phaser from "phaser";
import { DEPTH } from "@/renderer/game/config";
import type { CharacterAssets } from "@/shared/ipc-registry";

// Composited character sheets are 32x64 frames, 6 per row:
// walk down/left/right/up (rows 0-3), then sit-left (row 4) and sit-right (row 5).
const FRAME_W = 32;
const FRAME_H = 64;
export type Dir = "down" | "left" | "right" | "up";
export type SitSide = "left" | "right";
const DIR_START: Record<Dir, number> = { down: 0, left: 6, right: 12, up: 18 };
const SIT_START: Record<SitSide, number> = { left: 24, right: 30 };

/** Content rows within a frame: the art starts at the hair and ends at the soles. */
const HEAD_ROW = 18;
const SOLE_ROW = 62;

/** One origin for every character, so the player and NPCs sort on the same footing. */
export const CHAR_ORIGIN_X = 0.5;
export const CHAR_ORIGIN_Y = 0.86;

/**
 * Gap between a character's depth anchor (its origin) and its soles. Office objects
 * anchor on their content bottom — their floor contact — so characters must be compared
 * on floor contact too. Without this a character renders BEHIND everything for the last
 * ~7px of approach, i.e. their feet get eaten right where they step in front of a desk.
 */
const SOLE_OFFSET = SOLE_ROW - FRAME_H * CHAR_ORIGIN_Y;

/** Depth of a character whose origin sits at world `y`. */
export function characterDepth(y: number): number {
  return DEPTH.entityBase + y + SOLE_OFFSET;
}

/**
 * The frame region drawn while seated. The pack's own seated workers are head-and-
 * shoulders busts painted over the chair with the desk in front; cropping the walk sheet
 * at the origin row reproduces that silhouette, so a sitter lifted above their desk
 * (OfficeScene.seatDepth) doesn't dangle legs across it.
 */
export const SEAT_CROP = {
  x: 0,
  y: 0,
  w: FRAME_W,
  h: Math.round(FRAME_H * CHAR_ORIGIN_Y),
} as const;

/** Silhouette of that bust around its origin — what a seat tests for overlap. */
export const BUST = {
  halfWidth: 10,
  height: Math.ceil(FRAME_H * CHAR_ORIGIN_Y) - HEAD_ROW,
} as const;

/** Load a base64 PNG as a Phaser spritesheet under `key` (resolves when ready). */
function loadSpritesheetDataUrl(scene: Phaser.Scene, key: string, dataUrl: string): Promise<void> {
  return new Promise((resolve) => {
    if (scene.textures.exists(key)) {
      resolve();
      return;
    }
    scene.load.spritesheet(key, dataUrl, { frameWidth: FRAME_W, frameHeight: FRAME_H });
    scene.load.once(Phaser.Loader.Events.COMPLETE, () => resolve());
    scene.load.start();
  });
}

/** Create the walk + sit anims for a character texture (idempotent). */
export function ensureWalkAnims(scene: Phaser.Scene, key: string): void {
  for (const [dir, start] of Object.entries(DIR_START) as Array<[Dir, number]>) {
    const akey = `${key}-walk-${dir}`;
    if (scene.anims.exists(akey)) continue;
    scene.anims.create({
      key: akey,
      frames: scene.anims.generateFrameNumbers(key, { start, end: start + 5 }),
      frameRate: 9,
      repeat: -1,
    });
  }
  for (const [side, start] of Object.entries(SIT_START) as Array<[SitSide, number]>) {
    const akey = `${key}-sit-${side}`;
    if (scene.anims.exists(akey)) continue;
    scene.anims.create({
      key: akey,
      frames: scene.anims.generateFrameNumbers(key, { start, end: start + 5 }),
      frameRate: 4,
      repeat: -1,
    });
  }
}

/** Standing frame index for a direction (first frame of that direction's strip). */
export const idleFrame = (dir: Dir): number => DIR_START[dir];

/**
 * Compose a character in main, load its walk sheet into the scene, register
 * anims. Returns the assets (portrait etc.) for UI use. Texture key == seed-derived.
 */
export async function loadCharacter(
  scene: Phaser.Scene,
  key: string,
  seed: string,
): Promise<CharacterAssets> {
  const bridge = window.appBridge;
  if (!bridge) throw new Error("appBridge unavailable");
  const assets = await bridge.composeCharacter({ seed });
  await loadSpritesheetDataUrl(scene, key, assets.walkSheetDataUrl);
  ensureWalkAnims(scene, key);
  return assets;
}
