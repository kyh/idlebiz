import { describe, expect, it } from "vitest";
import { planSeats, type SeatPlan } from "./office-placement";

const emp = (id: string, deskIndex: number) => ({ id, deskIndex });
const plan = (entries: [string, number | null][]): SeatPlan => new Map(entries);
const none: SeatPlan = new Map();

describe("planSeats", () => {
  it("seats everyone at the desk they were hired into when it is free", () => {
    const out = planSeats(3, [emp("a", 0), emp("b", 1), emp("c", 2)], none);
    expect([...out]).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("wraps a hire index past the seat count onto the seats that exist", () => {
    expect(planSeats(2, [emp("a", 5)], none).get("a")).toBe(1);
  });

  it("keeps an incumbent in place when a newcomer was hired into their desk", () => {
    const before = plan([["a", 0]]);
    // the newcomer is listed first, and still does not displace anyone
    const out = planSeats(2, [emp("b", 0), emp("a", 0)], before);
    expect(out.get("a")).toBe(0);
    expect(out.get("b")).toBe(1);
  });

  it("gives the lowest free seat when the hired desk is taken", () => {
    const out = planSeats(4, [emp("a", 2), emp("b", 2), emp("c", 2)], none);
    expect(out.get("a")).toBe(2);
    expect(out.get("b")).toBe(0);
    expect(out.get("c")).toBe(1);
  });

  it("leaves the overflow standing, then seats them when a desk frees up", () => {
    const roster = [emp("a", 0), emp("b", 1), emp("c", 2)];
    const full = planSeats(2, roster, none);
    expect(full.get("c")).toBeNull();

    // a is released: c walks to the freed desk, b stays put
    const after = planSeats(2, [emp("b", 1), emp("c", 2)], full);
    expect(after.get("b")).toBe(1);
    expect(after.get("c")).toBe(0);
  });

  it("forgets a previous seat the layout no longer has", () => {
    const before = plan([["a", 7]]);
    expect(planSeats(2, [emp("a", 1)], before).get("a")).toBe(1);
  });

  it("tolerates a hire index that is not a whole number", () => {
    expect(planSeats(3, [emp("a", 1.7)], none).get("a")).toBe(1);
    expect(planSeats(3, [emp("b", Number.NaN)], none).get("b")).toBe(0);
    expect(planSeats(3, [emp("c", -1)], none).get("c")).toBe(2);
  });

  it("answers null for everyone when there are no work seats at all", () => {
    const out = planSeats(0, [emp("a", 0), emp("b", 3)], none);
    expect(out.get("a")).toBeNull();
    expect(out.get("b")).toBeNull();
  });

  it("does not seat an employee who left, even if they had a seat", () => {
    const before = plan([["a", 0]]);
    const out = planSeats(2, [emp("b", 0)], before);
    expect(out.has("a")).toBe(false);
    expect(out.get("b")).toBe(0);
  });
});
