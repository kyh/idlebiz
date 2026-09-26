import type { OfficeLayoutData, PixelPoint } from "@/shared/office-layout-schema";

// BFS walks half-tile nodes where a 16x12 body fits, probing its four corners.

/** Node spacing of the path grid, in px (half a 32px tile). */
const PATH_STEP = 16;
/** Half-extents of the body box that collides with the grid. */
const BODY_HALF_WIDTH = 8;
const BODY_HALF_HEIGHT = 6;
/** How far (in nodes) a blocked target is allowed to snap to reach a walkable one. */
const PATH_SEARCH_RADIUS = 6;

const CARDINAL_STEPS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
];

export interface PathTile {
  readonly tx: number;
  readonly ty: number;
}

/** The collision grid plus the world it covers, ready to probe. */
export interface WalkGrid {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  readonly solid: readonly (readonly boolean[])[];
  /** Path-grid extent: ceil(width / PATH_STEP) by ceil(height / PATH_STEP). */
  readonly pathCols: number;
  readonly pathRows: number;
}

type GridSource = Pick<
  OfficeLayoutData,
  "cell" | "cols" | "rows" | "width" | "height" | "collision" | "seats" | "spawn"
>;

/** The authored collision, cell for cell, before the walker's own rules. */
const rawGrid = (layout: GridSource): WalkGrid => ({
  cell: layout.cell,
  cols: layout.cols,
  height: layout.height,
  pathCols: Math.ceil(layout.width / PATH_STEP),
  pathRows: Math.ceil(layout.height / PATH_STEP),
  rows: layout.rows,
  solid: layout.collision.map((row) => Array.from(row, (ch) => ch === "1")),
  width: layout.width,
});

/** A collision cell, by row and column. */
interface GridCell {
  readonly r: number;
  readonly c: number;
}

const cellOf = (grid: WalkGrid, p: PixelPoint): GridCell => ({
  c: Math.floor(p.x / grid.cell),
  r: Math.floor(p.y / grid.cell),
});

/** A copy of the grid with the given cells solid. */
const withSolid = (grid: WalkGrid, cells: Iterable<GridCell>): WalkGrid => {
  const solid = grid.solid.map((row) => [...row]);
  for (const { r, c } of cells) {
    const row = solid[r];
    if (row && c >= 0 && c < row.length) {
      row[c] = true;
    }
  }
  return { ...grid, solid };
};

/** Is the collision cell under this pixel solid? Off-grid is solid. */
export const solidAt = (grid: WalkGrid, x: number, y: number): boolean => {
  const c = Math.floor(x / grid.cell);
  const r = Math.floor(y / grid.cell);
  if (r < 0 || c < 0 || r >= grid.rows || c >= grid.cols) {
    return true;
  }
  return grid.solid[r]?.[c] ?? true;
};

const BODY_CORNERS: readonly (readonly [number, number])[] = [
  [-BODY_HALF_WIDTH, -BODY_HALF_HEIGHT],
  [BODY_HALF_WIDTH, -BODY_HALF_HEIGHT],
  [-BODY_HALF_WIDTH, BODY_HALF_HEIGHT],
  [BODY_HALF_WIDTH, BODY_HALF_HEIGHT],
];

/** Can a body centred here stand without any corner inside a solid cell? */
export const bodyBlockedAt = (grid: WalkGrid, x: number, y: number): boolean =>
  BODY_CORNERS.some(([dx, dy]) => solidAt(grid, x + dx, y + dy));

/** Pixel centre of a path node. */
export const nodeCenter = (tile: PathTile): PixelPoint => ({
  x: tile.tx * PATH_STEP + PATH_STEP / 2,
  y: tile.ty * PATH_STEP + PATH_STEP / 2,
});

/** The path node a pixel falls in. */
export const tileOf = (x: number, y: number): PathTile => ({
  tx: Math.floor(x / PATH_STEP),
  ty: Math.floor(y / PATH_STEP),
});

export const walkableNode = (grid: WalkGrid, tile: PathTile): boolean => {
  if (tile.tx < 0 || tile.ty < 0 || tile.tx >= grid.pathCols || tile.ty >= grid.pathRows) {
    return false;
  }
  const p = nodeCenter(tile);
  return !bodyBlockedAt(grid, p.x, p.y);
};

/** The node itself if walkable, else the nearest walkable node in a growing ring. */
const nearestWalkable = (grid: WalkGrid, tile: PathTile): PathTile | null => {
  if (walkableNode(grid, tile)) {
    return tile;
  }
  for (let radius = 1; radius <= PATH_SEARCH_RADIUS; radius += 1) {
    for (let oy = -radius; oy <= radius; oy += 1) {
      for (let ox = -radius; ox <= radius; ox += 1) {
        if (Math.abs(ox) !== radius && Math.abs(oy) !== radius) {
          continue;
        }
        const candidate = { tx: tile.tx + ox, ty: tile.ty + oy };
        if (walkableNode(grid, candidate)) {
          return candidate;
        }
      }
    }
  }
  return null;
};

/** Nearest walkable node centre to a pixel, or null when nothing is in range. */
export const nearestFloor = (grid: WalkGrid, x: number, y: number): PixelPoint | null => {
  const tile = nearestWalkable(grid, tileOf(x, y));
  return tile ? nodeCenter(tile) : null;
};

const tileKey = (tile: PathTile): string => `${tile.tx},${tile.ty}`;

const parseTileKey = (key: string): PathTile => {
  const comma = key.indexOf(",");
  return { tx: Number(key.slice(0, comma)), ty: Number(key.slice(comma + 1)) };
};

const samePoint = (a: PixelPoint, b: PixelPoint): boolean => Math.hypot(a.x - b.x, a.y - b.y) < 1;

/** Pixel waypoints, or null when unreachable. Ends snap to walkable nodes; use the exact
 * target as the final waypoint when the body fits there. */
export const findPath = (grid: WalkGrid, from: PixelPoint, to: PixelPoint): PixelPoint[] | null => {
  const start = nearestWalkable(grid, tileOf(from.x, from.y));
  const goal = nearestWalkable(grid, tileOf(to.x, to.y));
  if (!start || !goal) {
    return null;
  }
  const goalPoint = bodyBlockedAt(grid, to.x, to.y) ? nodeCenter(goal) : to;
  const startKey = tileKey(start);
  const goalKey = tileKey(goal);
  const parent = new Map<string, string | null>([[startKey, null]]);
  const queue: PathTile[] = [start];
  let cursor = 0;
  let found = startKey === goalKey;
  while (cursor < queue.length && !found) {
    const cur = queue[cursor];
    cursor += 1;
    if (!cur) {
      break;
    }
    for (const [dx, dy] of CARDINAL_STEPS) {
      const next = { tx: cur.tx + dx, ty: cur.ty + dy };
      const nextKey = tileKey(next);
      if (!walkableNode(grid, next) || parent.has(nextKey)) {
        continue;
      }
      parent.set(nextKey, tileKey(cur));
      if (nextKey === goalKey) {
        found = true;
        break;
      }
      queue.push(next);
    }
  }
  if (!found) {
    return null;
  }
  const keys: string[] = [];
  let walkBack: string | null = goalKey;
  while (walkBack) {
    keys.unshift(walkBack);
    walkBack = parent.get(walkBack) ?? null;
  }
  const points = keys.map((key) => nodeCenter(parseTileKey(key)));
  // the start node is where the walker already stands
  points.shift();
  const last = points.at(-1);
  if (!last || !samePoint(last, goalPoint)) {
    points.push(goalPoint);
  }
  return points;
};

/** Every node key a walker starting at `from` can reach (BFS, flood fill). */
const reachableTiles = (grid: WalkGrid, from: PixelPoint): ReadonlySet<string> => {
  const start = nearestWalkable(grid, tileOf(from.x, from.y));
  const seen = new Set<string>();
  if (!start) {
    return seen;
  }
  seen.add(tileKey(start));
  const queue: PathTile[] = [start];
  let cursor = 0;
  while (cursor < queue.length) {
    const cur = queue[cursor];
    cursor += 1;
    if (!cur) {
      break;
    }
    for (const [dx, dy] of CARDINAL_STEPS) {
      const next = { tx: cur.tx + dx, ty: cur.ty + dy };
      const key = tileKey(next);
      if (seen.has(key) || !walkableNode(grid, next)) {
        continue;
      }
      seen.add(key);
      queue.push(next);
    }
  }
  return seen;
};

/** The authored collision with every seat's chair solid. */
export const authoredGrid = (layout: GridSource): WalkGrid => {
  const raw = rawGrid(layout);
  return withSolid(
    raw,
    layout.seats.map((seat) => cellOf(raw, seat)),
  );
};

/** Open cells no reachable body probes, such as narrow gaps beside furniture. */
const pocketCells = (grid: WalkGrid, spawn: PixelPoint): GridCell[] => {
  const probed = new Set<string>();
  for (const key of reachableTiles(grid, spawn)) {
    const p = nodeCenter(parseTileKey(key));
    for (const [dx, dy] of BODY_CORNERS) {
      const { r, c } = cellOf(grid, { x: p.x + dx, y: p.y + dy });
      probed.add(`${r},${c}`);
    }
  }
  const pockets: GridCell[] = [];
  for (const [r, row] of grid.solid.entries()) {
    for (const [c, solid] of row.entries()) {
      if (!solid && !probed.has(`${r},${c}`)) {
        pockets.push({ c, r });
      }
    }
  }
  return pockets;
};

// Chairs block walkers; sitters are placed on them. Seal pockets without changing
// reachability: no reachable body probes a pocket cell.
export const walkGridOf = (layout: GridSource): WalkGrid => {
  const seated = authoredGrid(layout);
  return withSolid(seated, pocketCells(seated, layout.spawn));
};
