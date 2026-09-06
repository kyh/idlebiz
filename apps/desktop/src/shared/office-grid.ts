import type { OfficeLayoutData, PixelPoint } from "./office-layout-schema.ts";

// ---------------------------------------------------------------------------
// Walking, as pure math over the authored collision grid.
//
// The scene paths NPCs and the player over this; main and the office builder
// validate a layout with it before saving; the static gate walks it from the
// command line. One implementation, so "reachable" means the same thing to
// the check that passed and the employee who then gets stuck.
//
// The body that collides is a 16x12 box probed at its four corners; paths are
// found by BFS over a half-tile node grid (a node is walkable when the body
// fits at its centre). Imports nothing but types so node can load it as-is.
// ---------------------------------------------------------------------------

/** Node spacing of the path grid, in px (half a 32px tile). */
const PATH_STEP = 16;
/** Half-extents of the body box that collides with the grid. */
const BODY_HALF_WIDTH = 8;
const BODY_HALF_HEIGHT = 6;
/** How far (in nodes) a blocked target is allowed to snap to reach a walkable one. */
const PATH_SEARCH_RADIUS = 6;

const CARDINAL_STEPS: ReadonlyArray<readonly [number, number]> = [
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
function rawGrid(layout: GridSource): WalkGrid {
  return {
    cell: layout.cell,
    cols: layout.cols,
    rows: layout.rows,
    width: layout.width,
    height: layout.height,
    solid: layout.collision.map((row) => Array.from(row, (ch) => ch === "1")),
    pathCols: Math.ceil(layout.width / PATH_STEP),
    pathRows: Math.ceil(layout.height / PATH_STEP),
  };
}

/** A collision cell, by row and column. */
export interface GridCell {
  readonly r: number;
  readonly c: number;
}

const cellOf = (grid: WalkGrid, p: PixelPoint): GridCell => ({
  r: Math.floor(p.y / grid.cell),
  c: Math.floor(p.x / grid.cell),
});

/** A copy of the grid with the given cells solid. */
function withSolid(grid: WalkGrid, cells: Iterable<GridCell>): WalkGrid {
  const solid = grid.solid.map((row) => [...row]);
  for (const { r, c } of cells) {
    const row = solid[r];
    if (row && c >= 0 && c < row.length) row[c] = true;
  }
  return { ...grid, solid };
}

/**
 * Cells no reachable body ever probes: open floor that can only be looked at.
 * A lane one cell wide, a corner behind a plant, the chair a seat sits in — the
 * 16x12 body cannot fit, so nothing walkable ever touches them. Left open they
 * read as places to go and make the nodes beside them stand half inside furniture.
 */
export function pocketCells(grid: WalkGrid, spawn: PixelPoint): GridCell[] {
  const probed = new Set<string>();
  for (const key of reachableTiles(grid, spawn)) {
    const p = nodeCenter(parseTileKey(key));
    for (const [dx, dy] of BODY_CORNERS) {
      const { r, c } = cellOf(grid, { x: p.x + dx, y: p.y + dy });
      probed.add(`${r},${c}`);
    }
  }
  const pockets: GridCell[] = [];
  grid.solid.forEach((row, r) => {
    row.forEach((solid, c) => {
      if (!solid && !probed.has(`${r},${c}`)) pockets.push({ r, c });
    });
  });
  return pockets;
}

/**
 * The grid the office is walked on. Two rules the authored collision does not
 * have to know about: a seat's cell is solid (the chair is furniture; sitters
 * are placed on it, walkers must not stand in it), and pockets are sealed.
 * Sealing never changes what is reachable — a pocket is by definition a cell no
 * reachable body touches — so the scene, the save gate and the builder agree.
 */
export function walkGridOf(layout: GridSource): WalkGrid {
  const seated = authoredGrid(layout);
  return withSolid(seated, pocketCells(seated, layout.spawn));
}

/** The authored collision with chairs solid and nothing sealed: what a layout promises. */
export function authoredGrid(layout: GridSource): WalkGrid {
  const raw = rawGrid(layout);
  return withSolid(
    raw,
    layout.seats.map((seat) => cellOf(raw, seat)),
  );
}

/**
 * The grid with these standing spots closed and the pockets that leaves sealed.
 * The scene uses it for the spots where the founder could not be seen: a node
 * and a cell are one and the same on the 16px grid, so closing the node's cell
 * is what stops anyone standing there.
 */
export function withoutNodes(
  grid: WalkGrid,
  spawn: PixelPoint,
  nodes: readonly PixelPoint[],
): WalkGrid {
  const closed = withSolid(
    grid,
    nodes.map((node) => cellOf(grid, node)),
  );
  return withSolid(closed, pocketCells(closed, spawn));
}

/** The authored collision with the walker's rules written into it, for saving. */
export function sealedCollision(layout: GridSource): string[] {
  return walkGridOf(layout).solid.map((row) => row.map((s) => (s ? "1" : "0")).join(""));
}

/** Is the collision cell under this pixel solid? Off-grid is solid. */
export function solidAt(grid: WalkGrid, x: number, y: number): boolean {
  const c = Math.floor(x / grid.cell);
  const r = Math.floor(y / grid.cell);
  if (r < 0 || c < 0 || r >= grid.rows || c >= grid.cols) return true;
  return grid.solid[r]?.[c] ?? true;
}

const BODY_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-BODY_HALF_WIDTH, -BODY_HALF_HEIGHT],
  [BODY_HALF_WIDTH, -BODY_HALF_HEIGHT],
  [-BODY_HALF_WIDTH, BODY_HALF_HEIGHT],
  [BODY_HALF_WIDTH, BODY_HALF_HEIGHT],
];

/** Can a body centred here stand without any corner inside a solid cell? */
export function bodyBlockedAt(grid: WalkGrid, x: number, y: number): boolean {
  return BODY_CORNERS.some(([dx, dy]) => solidAt(grid, x + dx, y + dy));
}

/** Pixel centre of a path node. */
export function nodeCenter(tile: PathTile): PixelPoint {
  return { x: tile.tx * PATH_STEP + PATH_STEP / 2, y: tile.ty * PATH_STEP + PATH_STEP / 2 };
}

/** The path node a pixel falls in. */
export function tileOf(x: number, y: number): PathTile {
  return { tx: Math.floor(x / PATH_STEP), ty: Math.floor(y / PATH_STEP) };
}

export function walkableNode(grid: WalkGrid, tile: PathTile): boolean {
  if (tile.tx < 0 || tile.ty < 0 || tile.tx >= grid.pathCols || tile.ty >= grid.pathRows)
    return false;
  const p = nodeCenter(tile);
  return !bodyBlockedAt(grid, p.x, p.y);
}

/** The node itself if walkable, else the nearest walkable node in a growing ring. */
function nearestWalkable(grid: WalkGrid, tile: PathTile): PathTile | null {
  if (walkableNode(grid, tile)) return tile;
  for (let radius = 1; radius <= PATH_SEARCH_RADIUS; radius += 1) {
    for (let oy = -radius; oy <= radius; oy += 1) {
      for (let ox = -radius; ox <= radius; ox += 1) {
        if (Math.abs(ox) !== radius && Math.abs(oy) !== radius) continue;
        const candidate = { tx: tile.tx + ox, ty: tile.ty + oy };
        if (walkableNode(grid, candidate)) return candidate;
      }
    }
  }
  return null;
}

/** Nearest walkable node centre to a pixel, or null when nothing is in range. */
export function nearestFloor(grid: WalkGrid, x: number, y: number): PixelPoint | null {
  const tile = nearestWalkable(grid, tileOf(x, y));
  return tile ? nodeCenter(tile) : null;
}

const tileKey = (tile: PathTile): string => `${tile.tx},${tile.ty}`;

function parseTileKey(key: string): PathTile {
  const comma = key.indexOf(",");
  return { tx: Number(key.slice(0, comma)), ty: Number(key.slice(comma + 1)) };
}

function samePoint(a: PixelPoint, b: PixelPoint): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < 1;
}

/**
 * Waypoints (px) from one pixel to another, or null when unreachable.
 *
 * Either end snaps to the nearest walkable node, so walking "to a desk" walks up to
 * it. The final waypoint is the exact target when the body fits there, else the
 * node it snapped to — the walker ends where it can actually stand.
 */
export function findPath(grid: WalkGrid, from: PixelPoint, to: PixelPoint): PixelPoint[] | null {
  const start = nearestWalkable(grid, tileOf(from.x, from.y));
  const goal = nearestWalkable(grid, tileOf(to.x, to.y));
  if (!start || !goal) return null;
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
    if (!cur) break;
    for (const [dx, dy] of CARDINAL_STEPS) {
      const next = { tx: cur.tx + dx, ty: cur.ty + dy };
      const nextKey = tileKey(next);
      if (!walkableNode(grid, next) || parent.has(nextKey)) continue;
      parent.set(nextKey, tileKey(cur));
      if (nextKey === goalKey) {
        found = true;
        break;
      }
      queue.push(next);
    }
  }
  if (!found) return null;
  const keys: string[] = [];
  let walkBack: string | null = goalKey;
  while (walkBack) {
    keys.unshift(walkBack);
    walkBack = parent.get(walkBack) ?? null;
  }
  const points = keys.map((key) => nodeCenter(parseTileKey(key)));
  points.shift(); // the start node is where the walker already stands
  const last = points[points.length - 1];
  if (!last || !samePoint(last, goalPoint)) points.push(goalPoint);
  return points;
}

/** Every node key a walker starting at `from` can reach (BFS, flood fill). */
export function reachableTiles(grid: WalkGrid, from: PixelPoint): ReadonlySet<string> {
  const start = nearestWalkable(grid, tileOf(from.x, from.y));
  const seen = new Set<string>();
  if (!start) return seen;
  seen.add(tileKey(start));
  const queue: PathTile[] = [start];
  let cursor = 0;
  while (cursor < queue.length) {
    const cur = queue[cursor];
    cursor += 1;
    if (!cur) break;
    for (const [dx, dy] of CARDINAL_STEPS) {
      const next = { tx: cur.tx + dx, ty: cur.ty + dy };
      const key = tileKey(next);
      if (seen.has(key) || !walkableNode(grid, next)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return seen;
}

/** Every node centre a walker starting at `from` can stand on. */
export function reachableNodes(grid: WalkGrid, from: PixelPoint): PixelPoint[] {
  return [...reachableTiles(grid, from)].map((key) => nodeCenter(parseTileKey(key)));
}

/** Can a walker whose reachable set is `reachable` get to (or beside) this pixel? */
export function canReach(grid: WalkGrid, reachable: ReadonlySet<string>, to: PixelPoint): boolean {
  const goal = nearestWalkable(grid, tileOf(to.x, to.y));
  return goal !== null && reachable.has(tileKey(goal));
}

const at = (p: PixelPoint): string => `${p.x},${p.y}`;

/**
 * Everything wrong with a layout that the schema cannot see: places the office
 * promises people can go, that nobody can actually walk to. Empty means clean.
 *
 * Reachability is from the founder's spawn, the one point every walker shares
 * the floor with. A seat off in a sealed room passes the schema and fails here.
 */
export function layoutIssues(layout: OfficeLayoutData): string[] {
  // judged on the layout as authored: sealing a pocket must not let a seat in a
  // sealed room pass by snapping to the nearest floor on the other side of its wall
  const grid = authoredGrid(layout);
  const issues: string[] = [];
  const inWorld = (p: PixelPoint): boolean =>
    p.x >= 0 && p.y >= 0 && p.x < layout.width && p.y < layout.height;

  if (layout.collision.length !== layout.rows)
    issues.push(`collision has ${layout.collision.length} rows, expected ${layout.rows}`);
  layout.collision.forEach((row, r) => {
    if (row.length !== layout.cols)
      issues.push(`collision row ${r} has ${row.length} cells, expected ${layout.cols}`);
  });
  if (issues.length > 0) return issues; // the grid itself is wrong; nothing on it can be judged

  // The founder is placed at the spawn exactly, never snapped: a body inside a
  // wall there can't take a single step.
  if (!inWorld(layout.spawn)) issues.push(`spawn ${at(layout.spawn)} is outside the world`);
  else if (bodyBlockedAt(grid, layout.spawn.x, layout.spawn.y))
    issues.push(`spawn ${at(layout.spawn)} is inside collision`);
  if (issues.length > 0) return issues; // nothing else can be judged without a start

  const reachable = reachableTiles(grid, layout.spawn);
  if (!inWorld(layout.door)) issues.push(`door ${at(layout.door)} is outside the world`);
  else if (!canReach(grid, reachable, layout.door))
    issues.push(`door ${at(layout.door)} is unreachable from spawn`);

  const seen = new Map<string, number>();
  layout.seats.forEach((seat, i) => {
    const label = `seat ${i} (${seat.role} at ${at(seat)})`;
    const prior = seen.get(at(seat));
    if (prior !== undefined) issues.push(`${label} duplicates seat ${prior}`);
    else seen.set(at(seat), i);
    if (!inWorld(seat)) issues.push(`${label} is outside the world`);
    else if (!canReach(grid, reachable, seat)) issues.push(`${label} is unreachable from spawn`);
  });
  layout.pois.forEach((poi, i) => {
    const label = `poi ${i} (facing ${poi.face} at ${at(poi)})`;
    if (!inWorld(poi)) issues.push(`${label} is outside the world`);
    else if (!canReach(grid, reachable, poi)) issues.push(`${label} is unreachable from spawn`);
  });
  return issues;
}
