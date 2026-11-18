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

const loadSpritesheet = (scene: Phaser.Scene, key: string, url: string) =>
  // oxlint-disable-next-line promise/avoid-new -- wraps Phaser's event-based loader
  new Promise<void>((resolve) => {
    scene.load.spritesheet(key, url, { frameHeight: FRAME_H, frameWidth: FRAME_W });
    scene.load.once(Loader.Events.COMPLETE, () => resolve());
    scene.load.start();
  });

const ensureWalkAnims = (scene: Phaser.Scene, key: string) => {
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
export const loadCharacter = async (scene: Phaser.Scene, seed: string) => {
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
