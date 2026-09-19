import sharp from "sharp";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { CharacterAssets } from "@/shared/ipc-registry";
import { FRAME_H, FRAME_W } from "@/shared/character-frame";

// sharp needs real files: packaged sheets live in electron-builder's extraResources.
const EMPLOYEE_SHEET_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "employee-sheets")
  : path.join(app.getAppPath(), "resources", "employee-sheets");

// Source columns: 0-5 right, 6-11 up, 12-17 left, 18-23 down.
const WALK_TOP = 128;
// sitting band: 6 frames per facing, two facings
const SIT_TOP = 256;
const WALK_FRAMES = 6;
// Output rows in order — walk down, left, right, up, then sit-left, sit-right
// (the order characters.ts reads them in) — as [source band top, first column].
const OUT_ROWS: readonly (readonly [top: number, startCol: number])[] = [
  [WALK_TOP, 18],
  [WALK_TOP, 12],
  [WALK_TOP, 0],
  [WALK_TOP, 6],
  [SIT_TOP, 0],
  [SIT_TOP, 6],
];

let employeeSheetPaths: string[] | null = null;

const listEmployeeSheets = async (): Promise<string[]> => {
  const files = await readdir(EMPLOYEE_SHEET_DIR);
  const sheets = files
    .map((f) => f.trim())
    .filter((f) => /^employee-sheet-\d{2}\.png$/u.test(f))
    .toSorted()
    .map((f) => path.join(EMPLOYEE_SHEET_DIR, f));
  if (sheets.length === 0) {
    throw new Error(`no employee character sheets found in ${EMPLOYEE_SHEET_DIR}`);
  }
  return sheets;
};

const employeeSheets = async (): Promise<string[]> => {
  employeeSheetPaths ??= await listEmployeeSheets();
  return employeeSheetPaths;
};

/* oxlint-disable no-bitwise, unicorn/prefer-math-trunc -- FNV-1a seeding and mulberry32 are defined on wrapping int32 math */
const makeRng = (seed: string): (() => number) => {
  let h = 2_166_136_261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- hashes UTF-16 units; persisted seeds must keep their sheet
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};
/* oxlint-enable no-bitwise, unicorn/prefer-math-trunc */

const toDataUrl = (buf: Buffer): string => `data:image/png;base64,${buf.toString("base64")}`;

const OUT_W = FRAME_W * WALK_FRAMES;
const OUT_H = FRAME_H * OUT_ROWS.length;

/** Decode once, then copy walk and sit bands into the renderer's 192x384 layout. */
const buildWalkSheet = async (sheetPath: string): Promise<Buffer> => {
  const { data, info } = await sharp(sheetPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(OUT_W * OUT_H * 4);
  for (const [row, [bandTop, startCol]] of OUT_ROWS.entries()) {
    for (let y = 0; y < FRAME_H; y += 1) {
      const src = ((bandTop + y) * info.width + startCol * FRAME_W) * 4;
      const dst = (row * FRAME_H + y) * OUT_W * 4;
      data.copy(out, dst, src, src + OUT_W * 4);
    }
  }
  return sharp(out, { raw: { channels: 4, height: OUT_H, width: OUT_W } })
    .png()
    .toBuffer();
};

/** Seeds of the form "employee-sheet:<n>" pin an exact sheet. */
const indexForSeed = (seed: string, count: number): number => {
  const pinned = /^employee-sheet:(?<n>\d+)$/u.exec(seed)?.groups?.n;
  if (pinned !== undefined) {
    const n = Number(pinned);
    if (Number.isInteger(n) && n >= 1 && n <= count) {
      return n - 1;
    }
  }
  return Math.floor(makeRng(seed)() * count);
};

export const listFounderChoices = async (n: number): Promise<string[]> => {
  const sheets = await employeeSheets();
  const step = Math.max(1, Math.floor(sheets.length / n));
  const seeds: string[] = [];
  for (let i = 0; i < n && i * step < sheets.length; i += 1) {
    seeds.push(`employee-sheet:${i * step + 1}`);
  }
  return seeds;
};

/** The drawn bust that ships beside each sheet — a curated asset, so a missing one is a packaging error. */
const readBust = (sheetPath: string): Promise<Buffer> =>
  readFile(sheetPath.replace(/employee-sheet-(?<n>\d{2})\.png$/u, "employee-portrait-$<n>.png"));

// Cache by sheet so employees sharing a sheet reuse its assets.
const composed = new Map<string, Promise<CharacterAssets>>();

const buildAssets = async (sheetPath: string): Promise<CharacterAssets> => {
  const [walk, bust] = await Promise.all([buildWalkSheet(sheetPath), readBust(sheetPath)]);
  return { bustDataUrl: toDataUrl(bust), walkSheetDataUrl: toDataUrl(walk) };
};

const composeSheet = (sheetPath: string): Promise<CharacterAssets> => {
  let pending = composed.get(sheetPath);
  if (!pending) {
    pending = buildAssets(sheetPath);
    composed.set(sheetPath, pending);
  }
  return pending;
};

export const composeCharacter = async (seed: string): Promise<CharacterAssets> => {
  const sheets = await employeeSheets();
  const idx = indexForSeed(seed, sheets.length);
  const sheetPath = sheets[idx];
  if (!sheetPath) {
    throw new Error(`no employee sheet at index ${idx}`);
  }
  return composeSheet(sheetPath);
};
