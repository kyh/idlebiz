import { describe, expect, it } from "vitest";
import { keyedAt } from "./use-keyed-state";

describe("useKeyedState's stored value", () => {
  it("is kept for a render under the key it was stored under", () => {
    const stored = { key: "team:cast", value: 1 };
    expect(keyedAt(stored, "team:cast", 0)).toBe(stored);
  });

  it("starts over under a new key", () => {
    expect(keyedAt({ key: "team:cast", value: 1 }, "team:casting", 0)).toEqual({
      key: "team:casting",
      value: 0,
    });
  });

  it("starts over on a return to an earlier key with no set in between", () => {
    const away = keyedAt({ key: "team:cast", value: 1 }, "team:casting", 0);
    expect(keyedAt(away, "team:cast", 0)).toEqual({ key: "team:cast", value: 0 });
  });
});
