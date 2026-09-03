import { describe, expect, it } from "vitest";
import bundled from "@/renderer/game/office-design.json";
import {
  bodyBlockedAt,
  canReach,
  findPath,
  layoutIssues,
  nearestFloor,
  reachableTiles,
  walkGridOf,
} from "./office-grid";
import { officeLayoutSchema, type OfficeLayoutData } from "./office-layout-schema";

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

const spawn = { x: 24, y: 24 }; // node (1,1), in the west room
const eastSeat = { x: 120, y: 24 }; // node (7,1), in the east room

function office(
  collision: readonly string[],
  extra: Partial<OfficeLayoutData> = {},
): OfficeLayoutData {
  return {
    version: 2,
    tile: 32,
    width: 160,
    height: 96,
    cell: 16,
    cols: 10,
    rows: 6,
    spawn,
    door: spawn,
    seats: [{ role: "work", ...eastSeat }],
    pois: [],
    objects: [],
    collision: [...collision],
    ...extra,
  };
}

describe("walk grid", () => {
  const grid = walkGridOf(office(OPEN));

  it("blocks a body whose corners touch a solid cell", () => {
    expect(bodyBlockedAt(grid, 24, 24)).toBe(false); // cells 1,2 of row 1: open
    expect(bodyBlockedAt(grid, 72, 24)).toBe(true); // cells 4,5: 5 is the wall
    expect(bodyBlockedAt(grid, -4, 24)).toBe(true); // off-grid is solid
  });

  it("snaps a blocked target to the nearest walkable node", () => {
    // (104,24) is the wall's east face: the east room is one node away, the west two
    expect(nearestFloor(grid, 104, 24)).toEqual({ x: 120, y: 24 });
    expect(nearestFloor(grid, 8, 8)).toEqual({ x: 24, y: 24 });
  });

  it("paths through the corridor and ends exactly on a target the body fits at", () => {
    const path = findPath(grid, spawn, eastSeat);
    expect(path).not.toBeNull();
    expect(path?.at(-1)).toEqual(eastSeat);
    // every waypoint is somewhere the body can actually stand
    for (const p of path ?? []) expect(bodyBlockedAt(grid, p.x, p.y), `${p.x},${p.y}`).toBe(false);
  });

  it("ends on the snapped node when the target itself is blocked", () => {
    const path = findPath(grid, spawn, { x: 104, y: 24 });
    expect(path?.at(-1)).toEqual({ x: 120, y: 24 });
  });

  it("returns null when a wall seals the room off", () => {
    expect(findPath(walkGridOf(office(SEALED)), spawn, eastSeat)).toBeNull();
  });

  it("flood-fills exactly the rooms the spawn connects to", () => {
    const open = reachableTiles(grid, spawn);
    expect(canReach(grid, open, eastSeat)).toBe(true);
    const sealed = walkGridOf(office(SEALED));
    expect(canReach(sealed, reachableTiles(sealed, spawn), eastSeat)).toBe(false);
  });
});

describe("layoutIssues", () => {
  it("is clean when everything the layout promises can be walked to", () => {
    expect(layoutIssues(office(OPEN, { pois: [{ x: 120, y: 56, face: "up" }] }))).toEqual([]);
  });

  it("names a seat nobody can reach", () => {
    expect(layoutIssues(office(SEALED))).toEqual([
      "seat 0 (work at 120,24) is unreachable from spawn",
    ]);
  });

  it("names an unreachable point of interest and door", () => {
    const issues = layoutIssues(
      office(SEALED, { door: { x: 120, y: 56 }, pois: [{ x: 120, y: 40, face: "down" }] }),
    );
    expect(issues).toContain("door 120,56 is unreachable from spawn");
    expect(issues).toContain("poi 0 (facing down at 120,40) is unreachable from spawn");
  });

  it("names a seat placed on top of another", () => {
    const twice = office(OPEN, {
      seats: [
        { role: "work", x: 24, y: 40 },
        { role: "rest", x: 24, y: 40, sit: "left" },
      ],
    });
    expect(layoutIssues(twice)).toEqual(["seat 1 (rest at 24,40) duplicates seat 0"]);
  });

  it("refuses to judge anything else when the spawn itself is off the floor", () => {
    const stranded = office(OPEN, { spawn: { x: 400, y: 400 } });
    expect(layoutIssues(stranded)).toEqual(["spawn 400,400 is outside the world"]);
    // the founder is placed exactly there, so "near some floor" is not good enough
    const walled = office(OPEN, { spawn: { x: 88, y: 24 } });
    expect(layoutIssues(walled)).toEqual(["spawn 88,24 is inside collision"]);
  });

  it("rejects a collision grid that is not rows by cols before judging anything on it", () => {
    expect(layoutIssues(office(OPEN.slice(0, 5)))).toEqual(["collision has 5 rows, expected 6"]);
    const ragged = [...OPEN.slice(0, 3), "100000000", ...OPEN.slice(4)];
    expect(layoutIssues(office(ragged))).toEqual(["collision row 3 has 9 cells, expected 10"]);
  });

  it("passes the bundled office", () => {
    expect(layoutIssues(officeLayoutSchema.parse(bundled))).toEqual([]);
  });
});
