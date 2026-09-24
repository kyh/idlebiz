import { describe, expect, it } from "vitest";
import { loadedOf, settle } from "./use-async";

const before = (): Promise<string[]> => Promise.resolve(["a"]);
const after = (): Promise<string[]> => Promise.resolve(["a", "b"]);
const refused = (): Promise<string[]> => Promise.reject(new Error("no employee e1"));

describe("useAsync's outcome", () => {
  it("is loading until a read lands", () => {
    expect(loadedOf(null, before)).toEqual({ kind: "loading" });
  });

  it("is current only for the read of this render's deps", async () => {
    const landed = await settle(before);
    expect(loadedOf(landed, before)).toEqual({ current: true, kind: "ready", value: ["a"] });
    expect(loadedOf(landed, after)).toEqual({ current: false, kind: "ready", value: ["a"] });
  });

  it("turns a rejected read into a failure with its message", async () => {
    const landed = await settle(refused);
    expect(loadedOf(landed, refused)).toEqual({ kind: "failed", message: "no employee e1" });
  });

  it("is loading, not the old failure, while a read under new deps is in flight", async () => {
    expect(loadedOf(await settle(refused), after)).toEqual({ kind: "loading" });
  });
});
