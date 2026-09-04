import sharp from "sharp";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { CharacterAssets } from "@/shared/ipc-registry";
import { FRAME_H, FRAME_W } from "@/shared/character-frame";

// ---------------------------------------------------------------------------
// Build a unique employee sprite from bundled artist-assembled character
// sheets. We deliberately use these sheets rather than compositing the modular
// Body/Eyes/Outfit/Hair layers: the standalone Bodies sheets (1854px wide) are a
// different export version than the Eyes/Outfits/Hairstyles (1792px), so layering
// them misaligns into "bobbleheads". These sheets are pixel-
// perfect, and varied — guaranteed correct.
//
// Output (both base64 data URLs, no disk writes):
//   - walkSheetDataUrl: 192x384, 6 rows x 6 frames of 32x64
//                       (rows: walk down/left/right/up, then sit-left, sit-right)
//   - portraitDataUrl:  64x64, a crisp nearest-neighbour crop of the character's
//                       own down-facing head — so the portrait always matches the
//                       sprite exactly.
// ---------------------------------------------------------------------------

// The 20 employee sheets ship with the app as curated runtime assets.
// app.getAppPath() = apps/desktop in dev; a packaged build must include
// resources/ (electron-builder files config) for this to keep resolving.
const EMPLOYEE_SHEET_DIR = join(app.getAppPath(), "resources", "employee-sheets");

// 32px-tier sheet layout. Animation bands stack at 64px; the walk band sits at
// y=128. Within a band the 24 frames are grouped by direction (6 each). Verified
// against the real pixels: cols 0-5 face RIGHT, 6-11 UP, 12-17 LEFT, 18-23 DOWN —
// swapping left and right makes the player moonwalk.
const WALK_TOP = 128;
const SIT_TOP = 256; // sitting band: 6 frames per facing, two facings
const WALK_FRAMES = 6;
// Output rows in order — walk down, left, right, up, then sit-left, sit-right
// (the order characters.ts reads them in) — as [source band top, first column].
const OUT_ROWS: ReadonlyArray<readonly [top: number, startCol: number]> = [
  [WALK_TOP, 18],
  [WALK_TOP, 12],
  [WALK_TOP, 0],
  [WALK_TOP, 6],
  [SIT_TOP, 0],
  [SIT_TOP, 6],
];

let employeeSheetPaths: string[] | null = null;

async function listEmployeeSheets(): Promise<string[]> {
  const files = await readdir(EMPLOYEE_SHEET_DIR);
  const sheets = files
    .map((f) => f.trim())
    .filter((f) => /^employee-sheet-\d{2}\.png$/.test(f))
    .toSorted()
    .map((f) => join(EMPLOYEE_SHEET_DIR, f));
  if (sheets.length === 0) {
    throw new Error(`no employee character sheets found in ${EMPLOYEE_SHEET_DIR}`);
  }
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

/** The composited sheet: 6 frames wide, one row per OUT_ROWS entry. */
const OUT_W = FRAME_W * WALK_FRAMES;
const OUT_H = FRAME_H * OUT_ROWS.length;

/**
 * Re-pack a source sheet's walk + sit bands into the 192x384 6-row layout.
 * One decode of the source, then plain row copies: the pipeline-per-frame
 * version re-decoded the 1792px sheet 36 times per character.
 */
async function buildWalkSheet(sheetPath: string): Promise<Buffer> {
  const { data, info } = await sharp(sheetPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(OUT_W * OUT_H * 4);
  for (const [row, [bandTop, startCol]] of OUT_ROWS.entries()) {
    for (let y = 0; y < FRAME_H; y++) {
      const src = ((bandTop + y) * info.width + startCol * FRAME_W) * 4;
      const dst = (row * FRAME_H + y) * OUT_W * 4;
      data.copy(out, dst, src, src + OUT_W * 4);
    }
  }
  return sharp(out, { raw: { width: OUT_W, height: OUT_H, channels: 4 } })
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

/** Seeds of the form "employee-sheet:<n>" pin an exact sheet. */
function indexForSeed(seed: string, count: number): number {
  const pinned = /^employee-sheet:(\d+)$/.exec(seed);
  if (pinned && pinned[1]) {
    const n = Number(pinned[1]);
    if (Number.isInteger(n) && n >= 1 && n <= count) return n - 1;
  }
  return Math.floor(makeRng(seed)() * count);
}

/** Distinct, deterministic founder appearance choices for onboarding. */
export async function listFounderChoices(n: number): Promise<string[]> {
  const sheets = (employeeSheetPaths ??= await listEmployeeSheets());
  const step = Math.max(1, Math.floor(sheets.length / n));
  const seeds: string[] = [];
  for (let i = 0; i < n && i * step < sheets.length; i++) {
    seeds.push(`employee-sheet:${i * step + 1}`);
  }
  return seeds;
}

// A character is a function of its sheet, and there are twenty sheets: build
// each once per process, not once per employee per scene boot.
const composed = new Map<string, Promise<CharacterAssets>>();

function composeSheet(sheetPath: string): Promise<CharacterAssets> {
  let pending = composed.get(sheetPath);
  if (!pending) {
    pending = Promise.all([buildWalkSheet(sheetPath), buildPortrait(sheetPath)]).then(
      ([walk, portrait]) => ({
        walkSheetDataUrl: toDataUrl(walk),
        portraitDataUrl: toDataUrl(portrait),
      }),
    );
    composed.set(sheetPath, pending);
  }
  return pending;
}

export async function composeCharacter(seed: string): Promise<CharacterAssets> {
  const sheets = (employeeSheetPaths ??= await listEmployeeSheets());
  const idx = indexForSeed(seed, sheets.length);
  const sheetPath = sheets[idx];
  if (!sheetPath) throw new Error(`no employee sheet at index ${idx}`);
  return composeSheet(sheetPath);
}
