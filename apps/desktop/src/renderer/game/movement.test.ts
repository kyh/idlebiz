import { describe, expect, it } from "vitest";
import { walkGridOf } from "@/shared/office-grid";
import { facingToward, randomFloor, stepToward } from "./movement";

describe("facingToward", () => {
  it("faces along the dominant axis", () => {
    expect(facingToward(5, 1)).toBe("right");
    expect(facingToward(-5, 1)).toBe("left");
    expect(facingToward(1, -5)).toBe("up");
    expect(facingToward(1, 5)).toBe("down");
  });

  it("goes sideways on a diagonal, so held WASD keeps the same rule", () => {
    expect(facingToward(3, 3)).toBe("right");
    expect(facingToward(-3, -3)).toBe("left");
  });

  it("faces the room when there is nowhere to go", () => {
    expect(facingToward(0, 0)).toBe("down");
  });
});

describe("stepToward", () => {
  const from = { x: 10, y: 10 };

  it("arrives when the waypoint is within reach", () => {
    expect(stepToward(from, { x: 13, y: 14 }, 5)).toEqual({ kind: "arrive" });
    expect(stepToward(from, from, 0)).toEqual({ kind: "arrive" });
  });

  it("closes exactly `reach` px along the line to the waypoint, facing it", () => {
    const step = stepToward(from, { x: 40, y: 50 }, 5);
    expect(step.kind).toBe("advance");
    if (step.kind !== "advance") return;
    expect(Math.hypot(step.dx, step.dy)).toBeCloseTo(5);
    expect(step.dx / step.dy).toBeCloseTo(30 / 40);
    expect(step.facing).toBe("down");
  });

  it("faces the way it is going", () => {
    const step = stepToward(from, { x: -100, y: 12 }, 1);
    expect(step.kind === "advance" && step.facing).toBe("left");
  });
});

describe("randomFloor", () => {
  // 10x6 office of 16px cells; the body needs two open cells side by side.
  const grid = walkGridOf({
    width: 160,
    height: 96,
    cell: 16,
    cols: 10,
    rows: 6,
    collision: ["1111111111", "1000011001", "1000011001", "1000000001", "1000011001", "1111111111"],
  });
  const at = { x: 24, y: 24 };

  it("returns a node centre the body can stand on", () => {
    const spot = randomFloor(grid, at, 48, () => 0.5);
    expect(spot).toEqual({ x: 24, y: 24 });
  });

  it("keeps sampling until a walkable node turns up", () => {
    // the first draws land in the wall to the west; only the last pair is on the floor
    const draws = [0, 0.5, 0, 0.5, 0.5, 0.5];
    let i = 0;
    const spot = randomFloor(grid, at, 48, () => draws[i++] ?? 0.5);
    expect(spot).toEqual({ x: 24, y: 24 });
    expect(i).toBe(6);
  });

  it("gives up rather than return a wall", () => {
    expect(randomFloor(grid, at, 48, () => 0)).toBeNull();
  });
});
