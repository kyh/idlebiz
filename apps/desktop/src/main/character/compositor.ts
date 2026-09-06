import sharp from "sharp";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { CharacterAssets } from "@/shared/ipc-registry";
import { FRAME_H, FRAME_W } from "@/shared/character-frame";

// sharp needs real files: packaged sheets live in electron-builder's extraResources.
const EMPLOYEE_SHEET_DIR = app.isPackaged
  ? join(process.resourcesPath, "employee-sheets")
  : join(app.getAppPath(), "resources", "employee-sheets");

// Source columns: 0-5 right, 6-11 up, 12-17 left, 18-23 down.
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

const OUT_W = FRAME_W * WALK_FRAMES;
const OUT_H = FRAME_H * OUT_ROWS.length;

/** Decode once, then copy walk and sit bands into the renderer's 192x384 layout. */
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

// The down-facing head and shoulders occupy y18..50 within the 32x64 frame.
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

export async function listFounderChoices(n: number): Promise<string[]> {
  const sheets = (employeeSheetPaths ??= await listEmployeeSheets());
  const step = Math.max(1, Math.floor(sheets.length / n));
  const seeds: string[] = [];
  for (let i = 0; i < n && i * step < sheets.length; i++) {
    seeds.push(`employee-sheet:${i * step + 1}`);
  }
  return seeds;
}

// Cache by sheet so employees sharing a sheet reuse its assets.
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
