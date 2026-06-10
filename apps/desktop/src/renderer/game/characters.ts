import Phaser from "phaser";
import type { CharacterAssets } from "@/shared/ipc-registry";

// Composited character sheets are 32x64 frames: down 0-5, left 6-11, right 12-17, up 18-23.
const FRAME_W = 32;
const FRAME_H = 64;
export type Dir = "down" | "left" | "right" | "up";
const DIR_START: Record<Dir, number> = { down: 0, left: 6, right: 12, up: 18 };

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

/** Create the 4 directional walk anims for a character texture (idempotent). */
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
}

/** Standing frame index for a direction (first frame of that direction's strip). */
export const idleFrame = (dir: Dir): number => DIR_START[dir];

/**
 * Compose a character in main, load its walk sheet into the scene, register
 * anims. Returns the assets (portrait etc.) for UI use. Texture key == seed-derived.
 */
export async function loadCharacter(scene: Phaser.Scene, key: string, seed: string): Promise<CharacterAssets> {
  const bridge = window.appBridge;
  if (!bridge) throw new Error("appBridge unavailable");
  const assets = await bridge.composeCharacter({ seed });
  await loadSpritesheetDataUrl(scene, key, assets.walkSheetDataUrl);
  ensureWalkAnims(scene, key);
  return assets;
}
