// Getting a character into a scene: the sheet its seed wears (character-art.ts), loaded as a
// spritesheet keyed by the sheet, so everyone wearing it shares one texture and one set of anims.
// A sheet stays loaded for the game, since there are only SHEET_COUNT of them. The anims' names
// are character-sheet.ts.
import { Loader } from "phaser";
import type Phaser from "phaser";
import { sheetUrl } from "@/renderer/character-art";
import { characterAnims } from "@/renderer/game/character-sheet";
import {
  DIRS,
  FRAME_H,
  FRAME_W,
  SIT_SIDES,
  SIT_START,
  STRIP_FRAMES,
  WALK_START,
} from "@repo/domain/character-frame";
import { sheetForSeed } from "@repo/domain/character-seed";

/** Load a sheet as a Phaser spritesheet under `key`; resolves once the loader is done with it. */
const loadSpritesheet = (scene: Phaser.Scene, key: string, url: string): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps Phaser's event-based loader
  new Promise((resolve) => {
    scene.load.spritesheet(key, url, { frameHeight: FRAME_H, frameWidth: FRAME_W });
    scene.load.once(Loader.Events.COMPLETE, () => resolve());
    scene.load.start();
  });

/** Create the walk + sit anims for a character texture (idempotent). */
const ensureWalkAnims = (scene: Phaser.Scene, key: string): void => {
  const anims = characterAnims(key);
  for (const dir of DIRS) {
    const start = WALK_START[dir];
    if (scene.anims.exists(anims.walk[dir])) {
      continue;
    }
    scene.anims.create({
      frameRate: 9,
      frames: scene.anims.generateFrameNumbers(key, { end: start + STRIP_FRAMES - 1, start }),
      key: anims.walk[dir],
      repeat: -1,
    });
  }
  for (const side of SIT_SIDES) {
    const start = SIT_START[side];
    if (scene.anims.exists(anims.sit[side])) {
      continue;
    }
    scene.anims.create({
      frameRate: 4,
      frames: scene.anims.generateFrameNumbers(key, { end: start + STRIP_FRAMES - 1, start }),
      key: anims.sit[side],
      repeat: -1,
    });
  }
};

/**
 * The texture key of the sheet `seed` wears, loaded with its anims registered. A sheet the game
 * already holds is reused as-is; one that does not load throws, failing whoever waits on it.
 */
export const loadCharacter = async (scene: Phaser.Scene, seed: string): Promise<string> => {
  const key = `character-${sheetForSeed(seed)}`;
  if (!scene.textures.exists(key)) {
    await loadSpritesheet(scene, key, sheetUrl(seed));
    if (!scene.textures.exists(key)) {
      throw new Error(`could not load ${sheetUrl(seed)}`);
    }
  }
  ensureWalkAnims(scene, key);
  return key;
};
