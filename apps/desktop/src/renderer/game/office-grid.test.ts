import { describe, expect, it } from "vitest";
import { bodyBlockedAt, findPath, nearestFloor, walkGridOf } from "./office-grid";
import type { OfficeLayoutData } from "./office-layout-schema";

const OPEN = ["1111111111", "1000011001", "1000011001", "1000000001", "1000011001", "1111111111"];
const SEALED = ["1111111111", "1000011001", "1000011001", "1000011001", "1000011001", "1111111111"];

const spawn = { x: 24, y: 24 };
const eastSpot = { x: 120, y: 24 };

const office = (collision: readonly string[], extra: Partial<OfficeLayoutData> = {}) =>
  ({
    cell: 16,
    collision: [...collision],
    cols: 10,
    door: spawn,
    height: 96,
    objects: [],
    pois: [],
    rows: 6,
    seats: [],
    spawn,
    width: 160,
    ...extra,
  }) satisfies OfficeLayoutData;

const eastSeat: Partial<OfficeLayoutData> = {
  seats: [{ facing: "down", role: "work", ...eastSpot }],
};

describe("walk grid", () => {
  const grid = walkGridOf(office(OPEN));

  it("blocks a body whose corners touch a solid cell", () => {
    expect(bodyBlockedAt(grid, 24, 24)).toBe(false);
    expect(bodyBlockedAt(grid, 72, 24)).toBe(true);
    expect(bodyBlockedAt(grid, -4, 24)).toBe(true);
  });

  it("snaps a blocked target to the nearest walkable node", () => {
    expect(nearestFloor(grid, 104, 24)).toEqual({ x: 120, y: 24 });
    expect(nearestFloor(grid, 8, 8)).toEqual({ x: 24, y: 24 });
  });

  it("paths through the corridor and ends exactly on a target the body fits at", () => {
    const path = findPath(grid, spawn, eastSpot);
    expect(path?.at(-1)).toEqual(eastSpot);

    for (const p of path ?? []) {
      expect(bodyBlockedAt(grid, p.x, p.y), `${p.x},${p.y}`).toBe(false);
    }
  });

  it("ends on the snapped node when the target itself is blocked", () => {
    const path = findPath(grid, spawn, { x: 104, y: 24 });
    expect(path?.at(-1)).toEqual({ x: 120, y: 24 });
  });

  it("walks as close as the wall allows when the room beyond is sealed", () => {
    const path = findPath(walkGridOf(office(SEALED)), spawn, eastSpot);
    expect(path?.at(-1)).toEqual({ x: 56, y: 24 });
  });

  it("makes a seat's chair solid and seals floor no body can probe", () => {
    const seated = walkGridOf(office(OPEN, eastSeat));
    expect(bodyBlockedAt(seated, eastSpot.x, eastSpot.y)).toBe(true);
    const pocketed = walkGridOf(office(SEALED));
    expect(pocketed.solid[1]?.[7]).toBe(true);
  });
});
