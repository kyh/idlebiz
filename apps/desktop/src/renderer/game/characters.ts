// Getting a character into (and out of) a scene: composed in main, loaded as a
// walk sheet, its anims registered. The sheet's geometry is character-sheet.ts.
import Phaser from "phaser";
import { bridge } from "@/renderer/bridge";
import { characterAnims, DIR_START, SIT_START } from "@/renderer/game/character-sheet";
import { DIRS, FRAME_H, FRAME_W, SIT_SIDES } from "@/shared/character-frame";

/** Load a base64 PNG as a Phaser spritesheet under `key` (resolves when ready). */
function loadSpritesheetDataUrl(scene: Phaser.Scene, key: string, dataUrl: string): Promise<void> {
  return new Promise((resolve) => {
    scene.load.spritesheet(key, dataUrl, { frameWidth: FRAME_W, frameHeight: FRAME_H });
    scene.load.once(Phaser.Loader.Events.COMPLETE, () => resolve());
    scene.load.start();
  });
}

/** Create the walk + sit anims for a character texture (idempotent). */
function ensureWalkAnims(scene: Phaser.Scene, key: string): void {
  const anims = characterAnims(key);
  for (const dir of DIRS) {
    const start = DIR_START[dir];
    if (scene.anims.exists(anims.walk[dir])) continue;
    scene.anims.create({
      key: anims.walk[dir],
      frames: scene.anims.generateFrameNumbers(key, { start, end: start + 5 }),
      frameRate: 9,
      repeat: -1,
    });
  }
  for (const side of SIT_SIDES) {
    const start = SIT_START[side];
    if (scene.anims.exists(anims.sit[side])) continue;
    scene.anims.create({
      key: anims.sit[side],
      frames: scene.anims.generateFrameNumbers(key, { start, end: start + 5 }),
      frameRate: 4,
      repeat: -1,
    });
  }
}

/**
 * Make `key` a ready character: composed in main from `seed`, loaded as a walk sheet,
 * anims registered. A texture the scene already holds is reused as-is — no compositor
 * round trip for a colleague it has drawn before.
 */
export async function loadCharacter(scene: Phaser.Scene, key: string, seed: string): Promise<void> {
  if (!scene.textures.exists(key)) {
    const assets = await bridge().composeCharacter({ seed });
    await loadSpritesheetDataUrl(scene, key, assets.walkSheetDataUrl);
  }
  ensureWalkAnims(scene, key);
}

/**
 * Free a character the scene is done with: its anims, then its texture. Anything still
 * drawing the texture throws on its next render, so destroy its sprites first.
 */
export function unloadCharacter(scene: Phaser.Scene, key: string): void {
  const anims = characterAnims(key);
  for (const dir of DIRS) scene.anims.remove(anims.walk[dir]);
  for (const side of SIT_SIDES) scene.anims.remove(anims.sit[side]);
  if (scene.textures.exists(key)) scene.textures.remove(key);
}
