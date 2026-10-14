import { describe, expect, it } from "vitest";
import { SHEET_COLUMNS, SIT_START, STRIP_FRAMES, WALK_START } from "./character-frame";

describe("a sheet's strips", () => {
  it("each lie along one row, so no anim runs into the next row's frames", () => {
    const starts = [...Object.values(WALK_START), ...Object.values(SIT_START)];
    const wrapping = starts.filter(
      (start) => (start % SHEET_COLUMNS) + STRIP_FRAMES > SHEET_COLUMNS,
    );
    expect(wrapping).toEqual([]);
  });
});
