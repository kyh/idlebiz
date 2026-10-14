import { describe, expect, it } from "vitest";
import { DEFAULT_FOUNDER_SEED } from "./domain";
import { founderChoices, SHEET_COUNT, sheetForSeed } from "./character-seed";

describe("sheetForSeed", () => {
  // A save keeps seeds, not sheets, so each case pins the sheet a saved seed wears.
  it.each([
    [DEFAULT_FOUNDER_SEED, 19],
    ["e2e-founder", 11],
    ["e2e-ada", 19],
    ["e2e-bo", 2],
    ["engineer-Ada-lq3k9x", 8],
    ["designer-Zoë-m1-0", 7],
    ["🙂", 11],
    ["", 13],
  ])("hashes %j to sheet %i", (seed, sheet) => {
    expect(sheetForSeed(seed)).toBe(sheet);
  });

  it("pins the sheet a pinning seed names", () => {
    expect(sheetForSeed("employee-sheet:1")).toBe(1);
    expect(sheetForSeed("employee-sheet:07")).toBe(7);
    expect(sheetForSeed(`employee-sheet:${SHEET_COUNT}`)).toBe(SHEET_COUNT);
  });

  it("hashes a pinning seed past the sheets like any other", () => {
    expect(sheetForSeed("employee-sheet:0")).toBe(19);
    expect(sheetForSeed(`employee-sheet:${SHEET_COUNT + 1}`)).toBe(4);
  });
});

describe("founderChoices", () => {
  it("spreads the looks on offer evenly across the sheets", () => {
    expect(founderChoices(6)).toEqual([
      "employee-sheet:1",
      "employee-sheet:4",
      "employee-sheet:7",
      "employee-sheet:10",
      "employee-sheet:13",
      "employee-sheet:16",
    ]);
  });

  it("offers each sheet once when asked for more looks than there are", () => {
    const every = founderChoices(SHEET_COUNT + 5);
    expect(every).toHaveLength(SHEET_COUNT);
    expect(new Set(every.map(sheetForSeed)).size).toBe(SHEET_COUNT);
  });
});
