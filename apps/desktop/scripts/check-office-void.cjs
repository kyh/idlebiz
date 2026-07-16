// Finds places the player can stand where their art hangs over nothing.
//
// The office keeps its art and its collision in two independent sections of
// office-design.json — sprites come from `objects`, solidity from `collision` — and
// nothing reconciles them. They disagree easily, because the probe that stops the player
// is a 16x12 box while the sprite drawn is 32x64: the art overhangs the body by ~8px per
// side. Let the body reach a wall tile whose opaque face starts inboard of its cell and
// the character renders against the background, sliced at the wall's edge. That is a real
// bug we shipped (the left wall marked one column solid where its tile is two wide).
//
// Fixing the data fixes one wall. This checks the class: for every place the player can
// actually reach, does any OPAQUE pixel of their sprite land on a pixel the room paints
// nothing at? If so, that pixel renders against COLORS.bg — the void.
//
// The office builder can author this back at any time, so run it after editing a layout.
//
// Usage: node scripts/check-office-void.cjs [--layout path.json] [--sheet path.png]
//        exit 0 = clean, 1 = the player can stand somewhere their art shows void
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const { objectFile } = require("./lib/office-assets.cjs");
const { paintOrder } = require("./lib/depth.cjs");
const { loadRaw } = require("./lib/pixels.cjs");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : fallback;
};
const layoutPath = flag("--layout", path.join(appRoot, "src/renderer/game/office-design.json"));
// any composited sheet: they share one silhouette, which is what we test
const sheetPath = flag(
  "--sheet",
  path.join(appRoot, "resources/employee-sheets/employee-sheet-01.png"),
);

// MUST match the renderer. characters.ts: FRAME_W/FRAME_H, CHAR_ORIGIN_X/Y.
// office-scene.ts: BODY_HALF_WIDTH/HEIGHT, PATH_STEP.
const FRAME_W = 32;
const FRAME_H = 64;
const CHAR_ORIGIN_X = 0.5;
const CHAR_ORIGIN_Y = 0.86;
const BODY_HALF_WIDTH = 8;
const BODY_HALF_HEIGHT = 6;
const PATH_STEP = 16;

/** Alpha of the room as the scene paints it: 1 where any object has an opaque pixel. */
async function paintedMask(layout) {
  const { width: W, height: H } = layout;
  const painted = new Uint8Array(W * H);
  for (const { obj } of paintOrder(layout.objects)) {
    const img = await loadRaw(objectFile(appRoot, obj));
    for (let sy = 0; sy < img.h; sy++) {
      for (let sx = 0; sx < img.w; sx++) {
        // flips mirror inside the sprite's own canvas, exactly like setFlip does
        const lx = obj.flipX ? img.w - 1 - sx : sx;
        const ly = obj.flipY ? img.h - 1 - sy : sy;
        if (img.data[(ly * img.w + lx) * 4 + 3] === 0) continue;
        const wx = Math.round(obj.x) + sx;
        const wy = Math.round(obj.y) + sy;
        if (wx < 0 || wy < 0 || wx >= W || wy >= H) continue;
        painted[wy * W + wx] = 1;
      }
    }
  }
  return painted;
}

/** The idle-down frame's opaque pixels — the silhouette actually drawn at a standstill. */
async function characterSilhouette() {
  const img = await loadRaw(sheetPath);
  const opaque = new Uint8Array(FRAME_W * FRAME_H);
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      // frame 0 of the sheet = walk-down rest pose, at the sheet's top-left
      if (img.data[(y * img.w + x) * 4 + 3] !== 0) opaque[y * FRAME_W + x] = 1;
    }
  }
  return opaque;
}

function makeGrid(layout) {
  const cell = layout.cell;
  const g = layout.collision.map((row) => Array.from(row, (ch) => ch === "1"));
  const solid = (x, y) => {
    const tx = Math.floor(x / cell);
    const ty = Math.floor(y / cell);
    if (ty < 0 || ty >= g.length) return true;
    const row = g[ty];
    if (!row || tx < 0 || tx >= row.length) return true;
    return row[tx];
  };
  const blocked = (x, y) =>
    solid(x - BODY_HALF_WIDTH, y - BODY_HALF_HEIGHT) ||
    solid(x + BODY_HALF_WIDTH, y - BODY_HALF_HEIGHT) ||
    solid(x - BODY_HALF_WIDTH, y + BODY_HALF_HEIGHT) ||
    solid(x + BODY_HALF_WIDTH, y + BODY_HALF_HEIGHT);
  return { blocked };
}

/** Node centres the player can actually walk to from spawn (BFS, as the scene paths). */
function reachableNodes(layout, blocked) {
  const cols = Math.ceil(layout.width / PATH_STEP);
  const rows = Math.ceil(layout.height / PATH_STEP);
  const at = (gx, gy) => ({ x: gx * PATH_STEP + PATH_STEP / 2, y: gy * PATH_STEP + PATH_STEP / 2 });
  const ok = (gx, gy) => {
    if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) return false;
    const p = at(gx, gy);
    return !blocked(p.x, p.y);
  };
  const start = [Math.floor(layout.spawn.x / PATH_STEP), Math.floor(layout.spawn.y / PATH_STEP)];
  const seen = new Set([start.join(",")]);
  const queue = [start];
  const out = [];
  while (queue.length) {
    const cur = queue.shift();
    out.push(at(cur[0], cur[1]));
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ]) {
      const nx = cur[0] + dx;
      const ny = cur[1] + dy;
      const k = `${nx},${ny}`;
      if (seen.has(k) || !ok(nx, ny)) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return out;
}

async function main() {
  const layout = JSON.parse(fs.readFileSync(layoutPath, "utf8"));
  const { width: W, height: H } = layout;
  const painted = await paintedMask(layout);
  const silhouette = await characterSilhouette();
  const { blocked } = makeGrid(layout);
  const nodes = reachableNodes(layout, blocked);

  const offenders = [];
  for (const node of nodes) {
    const left = Math.round(node.x - FRAME_W * CHAR_ORIGIN_X);
    const top = Math.round(node.y - FRAME_H * CHAR_ORIGIN_Y);
    let worst = 0;
    for (let y = 0; y < FRAME_H; y++) {
      for (let x = 0; x < FRAME_W; x++) {
        if (!silhouette[y * FRAME_W + x]) continue;
        const wx = left + x;
        const wy = top + y;
        // off-canvas is void too — there is certainly no room out there
        if (wx < 0 || wy < 0 || wx >= W || wy >= H || !painted[wy * W + wx]) worst++;
      }
    }
    if (worst > 0) offenders.push({ ...node, px: worst });
  }

  const total = FRAME_W * FRAME_H;
  console.log(`layout : ${path.relative(appRoot, layoutPath)}`);
  console.log(`checked: ${nodes.length} reachable standing positions`);
  if (offenders.length === 0) {
    console.log("clean  : nowhere the player can stand shows their art against the void");
    return;
  }
  offenders.sort((a, b) => b.px - a.px);
  console.log(
    `FOUND  : ${offenders.length} position(s) where the player's art hangs over nothing\n`,
  );
  for (const o of offenders.slice(0, 20)) {
    console.log(
      `  (${String(o.x).padStart(3)},${String(o.y).padStart(3)})  ${String(o.px).padStart(4)} px of sprite over void  (${((o.px / total) * 100).toFixed(1)}% of frame)`,
    );
  }
  if (offenders.length > 20) console.log(`  … and ${offenders.length - 20} more`);
  console.log(
    "\nThe art and the collision grid disagree here. Either the lane is opened too close\n" +
      "to a tile whose opaque face sits inboard of its cell, or the room has no backdrop\n" +
      "there. Fix the layout's collision, not the body box — see scripts/office-design2-classification.json.",
  );
  process.exitCode = 1;
}
void main();
