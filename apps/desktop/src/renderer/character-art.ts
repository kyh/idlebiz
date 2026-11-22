import { sheetForSeed } from "@repo/domain/character-seed";

const numbered = (seed: string) => String(sheetForSeed(seed)).padStart(2, "0");

/** The seed's sheet, in frames as @repo/domain/character-frame maps them. */
export const sheetUrl = (seed: string) => `/characters/employee-sheet-${numbered(seed)}.png`;

/** The drawn 44x44 head-and-shoulders bust that goes with it. */
export const bustUrl = (seed: string) => `/characters/employee-portrait-${numbered(seed)}.png`;
