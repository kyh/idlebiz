// Which bundled sheet a sprite seed wears. The save keeps seeds, not sheets, so this mapping is
// part of the save: change it and every saved character changes face.

/** The curated sheets the app ships, numbered from 1 as their files are. */
export const SHEET_COUNT = 20;

const PINNED = /^employee-sheet:(?<n>\d+)$/u;

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

/** The sheet `seed` wears, 1 to SHEET_COUNT. A seed "employee-sheet:<n>" pins sheet n. */
export const sheetForSeed = (seed: string): number => {
  const pinned = PINNED.exec(seed)?.groups?.n;
  if (pinned !== undefined) {
    const n = Number(pinned);
    if (Number.isInteger(n) && n >= 1 && n <= SHEET_COUNT) {
      return n;
    }
  }
  return Math.floor(makeRng(seed)() * SHEET_COUNT) + 1;
};

/** `n` looks the founder may pick from, spread evenly across the sheets, each a pinning seed. */
export const founderChoices = (n: number): string[] => {
  const step = Math.max(1, Math.floor(SHEET_COUNT / n));
  const seeds: string[] = [];
  for (let i = 0; i < n && i * step < SHEET_COUNT; i += 1) {
    seeds.push(`employee-sheet:${i * step + 1}`);
  }
  return seeds;
};
