import { describe, expect, it } from "vitest";
import { bodyBlockedAt, findPath, nearestFloor, walkGridOf } from "./office-grid";
import type { OfficeLayoutData } from "./office-layout-schema";

// A 10x6 office of 16px cells. The body is 16px wide, so a node needs its own
// cell AND the one to its right open: lanes are two cells wide.
//
//   0123456789
// 0 1111111111
// 1 1000011001   west room (cols 1-4) · wall · east room (cols 7-8)
// 2 1000011001
// 3 1000000001   the corridor joining them
// 4 1000011001
// 5 1111111111
const OPEN = ["1111111111", "1000011001", "1000011001", "1000000001", "1000011001", "1111111111"];
const SEALED = ["1111111111", "1000011001", "1000011001", "1000011001", "1000011001", "1111111111"];

// node (1,1), in the west room
const spawn = { x: 24, y: 24 };
// node (7,1), in the east room
const eastSpot = { x: 120, y: 24 };

const office = (
  collision: readonly string[],
  extra: Partial<OfficeLayoutData> = {},
): OfficeLayoutData => ({
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
});

/** The east room's spot as a workstation: its chair cell becomes furniture. */
const eastSeat: Partial<OfficeLayoutData> = {
  seats: [{ facing: "down", role: "work", ...eastSpot }],
};

describe("walk grid", () => {
  const grid = walkGridOf(office(OPEN));

  it("blocks a body whose corners touch a solid cell", () => {
    // cells 1,2 of row 1: open
    expect(bodyBlockedAt(grid, 24, 24)).toBe(false);
    // cells 4,5: 5 is the wall
    expect(bodyBlockedAt(grid, 72, 24)).toBe(true);
    // off-grid is solid
    expect(bodyBlockedAt(grid, -4, 24)).toBe(true);
  });

  it("snaps a blocked target to the nearest walkable node", () => {
    // (104,24) is the wall's east face: the east room is one node away, the west two
    expect(nearestFloor(grid, 104, 24)).toEqual({ x: 120, y: 24 });
    expect(nearestFloor(grid, 8, 8)).toEqual({ x: 24, y: 24 });
  });

  it("paths through the corridor and ends exactly on a target the body fits at", () => {
    const path = findPath(grid, spawn, eastSpot);
    expect(path?.at(-1)).toEqual(eastSpot);
    // every waypoint is somewhere the body can actually stand
    for (const p of path ?? []) {
      expect(bodyBlockedAt(grid, p.x, p.y), `${p.x},${p.y}`).toBe(false);
    }
  });

  it("ends on the snapped node when the target itself is blocked", () => {
    const path = findPath(grid, spawn, { x: 104, y: 24 });
    expect(path?.at(-1)).toEqual({ x: 120, y: 24 });
  });

  it("walks as close as the wall allows when the room beyond is sealed", () => {
    // the sealed room is a pocket the walker never enters, so the target snaps back
    // to this side of the wall instead of failing outright
    const path = findPath(walkGridOf(office(SEALED)), spawn, eastSpot);
    expect(path?.at(-1)).toEqual({ x: 56, y: 24 });
  });

  it("makes a seat's chair solid and seals floor no body can probe", () => {
    const seated = walkGridOf(office(OPEN, eastSeat));
    expect(bodyBlockedAt(seated, eastSpot.x, eastSpot.y)).toBe(true);
    // the sealed east room of SEALED is a pocket: every cell in it turns solid
    const pocketed = walkGridOf(office(SEALED));
    expect(pocketed.solid[1]?.[7]).toBe(true);
  });
});
