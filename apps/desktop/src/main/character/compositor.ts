import sharp from "sharp";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { CharacterAssets } from "@/shared/ipc-registry";

// ---------------------------------------------------------------------------
// Build a unique employee sprite from Limezu's pre-assembled "Premade" character
// sheets. We deliberately use the premades rather than compositing the modular
// Body/Eyes/Outfit/Hair layers: the standalone Bodies sheets (1854px wide) are a
// different export version than the Eyes/Outfits/Hairstyles (1792px), so layering
// them misaligns into "bobbleheads". The premades are artist-assembled, pixel-
// perfect, and varied — guaranteed correct.
//
// Output (both base64 data URLs, no disk writes):
//   - walkSheetDataUrl: 192x256, 4 dirs x 6 walk frames of 32x64
//                       (rows: down 0-5, left 6-11, right 12-17, up 18-23)
//   - portraitDataUrl:  64x64, a crisp nearest-neighbour crop of the character's
//                       own down-facing head — so the portrait always matches the
//                       sprite exactly.
// ---------------------------------------------------------------------------

// The 20 premade sheets ship with the app (copied from the Limezu pack).
// app.getAppPath() = apps/desktop in dev; a packaged build must include
// resources/ (electron-builder files config) for this to keep resolving.
const PREMADE_DIR = join(app.getAppPath(), "resources", "premades");

// Limezu 32px-tier sheet layout. Frames are 32w x 64h. Animation bands stack at
// 64px; the walk band sits at y=128. Within a band the 24 frames are grouped by
// direction (6 each). Verified against the real pixels: cols 0-5 face RIGHT,
// 6-11 UP, 12-17 LEFT, 18-23 DOWN. (Earlier we had left/right swapped, which made
// the player moonwalk — walking left played the right-facing strip.)
const FRAME_W = 32;
const FRAME_H = 64;
const WALK_TOP = 128;
const WALK_FRAMES = 6;
// output row order -> source column where that direction's 6 frames begin
const OUT_ROWS: ReadonlyArray<readonly [string, number]> = [
  ["down", 18],
  ["left", 12],
  ["right", 0],
  ["up", 6],
];

let premadePaths: string[] | null = null;

async function listPremades(): Promise<string[]> {
  const files = await readdir(PREMADE_DIR);
  const sheets = files
    .map((f) => f.trim())
    .filter((f) => /^Premade_Character_32x32_\d+\.png$/.test(f))
    .sort()
    .map((f) => join(PREMADE_DIR, f));
  if (sheets.length === 0) throw new Error(`no premade character sheets found in ${PREMADE_DIR}`);
  return sheets;
}

// ---- seeded RNG (deterministic per seed) -----------------------------------
function makeRng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toDataUrl = (buf: Buffer): string => `data:image/png;base64,${buf.toString("base64")}`;

/** Re-pack a premade sheet's walk band into the 192x256 4-dir x 6-frame layout. */
async function buildWalkSheet(sheetPath: string): Promise<Buffer> {
  const sheet = sharp(sheetPath);
  const tiles: sharp.OverlayOptions[] = [];
  for (let row = 0; row < OUT_ROWS.length; row++) {
    const startCol = OUT_ROWS[row]![1];
    for (let f = 0; f < WALK_FRAMES; f++) {
      const col = startCol + f;
      const cell = await sheet
        .clone()
        .extract({ left: col * FRAME_W, top: WALK_TOP, width: FRAME_W, height: FRAME_H })
        .toBuffer();
      tiles.push({ input: cell, left: f * FRAME_W, top: row * FRAME_H });
    }
  }
  return sharp({
    create: { width: FRAME_W * WALK_FRAMES, height: FRAME_H * OUT_ROWS.length, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(tiles)
    .png()
    .toBuffer();
}

/**
 * Crop the character's down-facing head+shoulders and upscale 2x (nearest-
 * neighbour) into a crisp 64x64 portrait — so the portrait always matches the
 * sprite exactly. Source: the down-idle frame (col 18, walk band). Within the
 * 32x64 cell the head+shoulders sit ~y18..y50, so we crop a 32x32 box there.
 */
const PORTRAIT_HEAD_TOP = WALK_TOP + 18;
async function buildPortrait(sheetPath: string): Promise<Buffer> {
  return sharp(sheetPath)
    .extract({ left: 18 * FRAME_W, top: PORTRAIT_HEAD_TOP, width: 32, height: 32 })
    .resize({ width: 64, height: 64, kernel: "nearest" })
    .png()
    .toBuffer();
}

/** Seeds of the form "premade:<n>" pin an exact sheet (used by the founder picker). */
function indexForSeed(seed: string, count: number): number {
  const pinned = /^premade:(\d+)$/.exec(seed);
  if (pinned && pinned[1]) {
    const n = Number(pinned[1]);
    if (Number.isInteger(n) && n >= 1 && n <= count) return n - 1;
  }
  return Math.floor(makeRng(seed)() * count);
}

/** Distinct, deterministic founder appearance choices for onboarding. */
export async function listFounderChoices(n: number): Promise<string[]> {
  const sheets = (premadePaths ??= await listPremades());
  const step = Math.max(1, Math.floor(sheets.length / n));
  const seeds: string[] = [];
  for (let i = 0; i < n && i * step < sheets.length; i++) seeds.push(`premade:${i * step + 1}`);
  return seeds;
}

export async function composeCharacter(seed: string): Promise<CharacterAssets> {
  const sheets = (premadePaths ??= await listPremades());
  const idx = indexForSeed(seed, sheets.length);
  const sheetPath = sheets[idx];
  if (!sheetPath) throw new Error(`no premade sheet at index ${idx}`);

  const [walk, portrait] = await Promise.all([buildWalkSheet(sheetPath), buildPortrait(sheetPath)]);

  return {
    seed,
    walkSheetDataUrl: toDataUrl(walk),
    portraitDataUrl: toDataUrl(portrait),
    parts: { premadeIndex: idx + 1 },
  };
}
