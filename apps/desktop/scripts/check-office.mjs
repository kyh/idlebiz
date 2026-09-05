// The static gate for office-design.json: does the office the data promises exist,
// and can the founder be seen walking around in it?
//
// Four lies are checked, all of which the game renders without complaint:
//
//  1. Places nobody can reach. The layout names seats, points of interest and a
//     door; each must be walkable from the founder's spawn, or an employee is
//     told to sit somewhere and stands in a corridor forever. `layoutIssues` in
//     src/shared/office-grid.ts is the judge — the same BFS the scene walks.
//
//  2. Floor nobody can stand on. A cell the collision grid leaves open that no
//     reachable body ever probes is a pocket: floor the founder can see and can
//     never step on — a lane narrower than the body, a corner behind a plant, a
//     room sealed by one tile. The walker seals these at load; the data should
//     not have them.
//
//  3. Places the player can stand where their art hangs over nothing. The office
//     keeps its art and its collision in two independent sections — sprites come
//     from `objects`, solidity from `collision` — and nothing reconciles them.
//     They disagree easily, because the probe that stops the player is a 16x12
//     box while the sprite drawn is 32x64: the art overhangs the body by ~8px per
//     side. Let the body reach a wall tile whose opaque face starts inboard of its
//     cell and the character renders against the background, sliced at the wall's
//     edge. For every place the player can actually reach: does any OPAQUE pixel
//     of their sprite land on a pixel the room paints nothing at?
//
//  4. Places the player can stand and not be seen. Characters y-sort on their
//     soles and furniture on its floor line, so standing north of a desk puts
//     your legs behind it — that is right. Standing where something in front of
//     you covers your FACE is not: a pocket behind a bookshelf, an overhead prop
//     over a lane. For every reachable position: what fraction of the face is
//     painted over by sprites the scene draws above the character?
//
// The office builder can author any of these back at any time, so run it after
// editing a layout. The schema, the grid, the paint order and the character frame
// are imported from src/shared as-is (node strips the types), so this cannot
// drift from what the game and the save handler check.
//
// Usage: node scripts/check-office.mjs [--layout path.json] [--sheet path.png]
//        exit 0 = clean, 1 = something the founder would hit or not see
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { parseOfficeLayout } from "../src/shared/office-layout-schema.ts";
import {
  authoredGrid,
  layoutIssues,
  pocketCells,
  reachableNodes,
  walkGridOf,
} from "../src/shared/office-grid.ts";
import { comparePaintOrder } from "../src/shared/office-depth.ts";
import { CHAR_ORIGIN_X, CHAR_ORIGIN_Y, FRAME_H, FRAME_W } from "../src/shared/character-frame.ts";
import { hiddenNodes, opaqueAt } from "../src/shared/office-sight.ts";
import { objectSpritePath } from "../src/renderer/game/office-object-sprite.ts";

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { sprite } = require("./lib/office-assets.cjs");
const { loadRaw } = require("./lib/pixels.cjs");

const { values: flags } = parseArgs({
  options: {
    layout: { type: "string", default: "src/renderer/game/office-design.json" },
    // any composited sheet: they share one silhouette, which is what we test
    sheet: { type: "string", default: "resources/employee-sheets/employee-sheet-01.png" },
  },
});
const layoutPath = path.resolve(appRoot, flags.layout);
const sheetPath = path.resolve(appRoot, flags.sheet);

const at = (p) => `(${String(p.x).padStart(3)},${String(p.y).padStart(3)})`;

/** Opaque-pixel coverage of a decoded PNG, the shape office-sight judges with. */
function maskOf(img) {
  const opaque = new Uint8Array(img.w * img.h);
  for (let i = 0; i < opaque.length; i++) opaque[i] = img.data[i * 4 + 3] === 0 ? 0 : 1;
  return { opaque, w: img.w, h: img.h };
}

/** Every sprite the room paints, in paint order, with its decoded pixels. */
async function paintedSprites(layout) {
  const out = [];
  for (const obj of layout.objects.toSorted(comparePaintOrder)) {
    out.push({
      obj,
      mask: maskOf(await sprite(path.join(appRoot, "public", objectSpritePath(obj)))),
    });
  }
  return out;
}

/** Alpha of the room as the scene paints it: 1 where any object has an opaque pixel. */
function paintedMask(layout, sprites) {
  const { width: W, height: H } = layout;
  const painted = new Uint8Array(W * H);
  for (const { obj, mask } of sprites) {
    for (let sy = 0; sy < mask.h; sy++) {
      for (let sx = 0; sx < mask.w; sx++) {
        if (!opaqueAt(mask, obj, sx, sy)) continue;
        const wx = Math.round(obj.x) + sx;
        const wy = Math.round(obj.y) + sy;
        if (wx >= 0 && wy >= 0 && wx < W && wy < H) painted[wy * W + wx] = 1;
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
  return { opaque, w: FRAME_W, h: FRAME_H };
}

/** Where the character's frame lands for an origin at `node`. */
const frameAt = (node) => ({
  left: Math.round(node.x - FRAME_W * CHAR_ORIGIN_X),
  top: Math.round(node.y - FRAME_H * CHAR_ORIGIN_Y),
});

function report(found, clean, offenders, format, advice) {
  if (offenders.length === 0) {
    console.log(`clean  : ${clean}`);
    return;
  }
  console.log(`FOUND  : ${offenders.length} ${found}\n`);
  for (const o of offenders.slice(0, 20)) console.log(`  ${format(o)}`);
  if (offenders.length > 20) console.log(`  … and ${offenders.length - 20} more`);
  console.log(`\n${advice}\n`);
  process.exitCode = 1;
}

// ---- 1. reachability -------------------------------------------------------
function checkReachability(layout) {
  const issues = layoutIssues(layout);
  console.log(
    `checked: ${layout.seats.length} seats, ${layout.pois.length} points of interest, the door`,
  );
  report(
    "place(s) the layout promises that nobody can reach",
    "everyone can reach everywhere the layout sends them",
    issues,
    (issue) => issue,
    "The scene snaps an unreachable target to the nearest floor within six nodes and\n" +
      "otherwise gives up silently. Open the lane in the collision grid, or move the\n" +
      "seat / POI / door onto floor the founder can walk to.",
  );
}

// ---- 2. floor pockets ------------------------------------------------------
function checkPockets(layout) {
  // the walker seals these at load; the gate reports them so the data stays honest
  const pockets = pocketCells(authoredGrid(layout), layout.spawn).map(({ r, c }) => ({
    x: c * layout.cell,
    y: r * layout.cell,
  }));
  console.log(`checked: ${layout.rows * layout.cols} collision cells`);
  report(
    "open floor cell(s) no body can ever stand on",
    "every open floor cell is somewhere the founder can stand",
    pockets,
    (p) => `${at(p)}`,
    "Open floor nobody can reach reads as a place to go, and the nodes beside it stand\n" +
      "half inside furniture. Widen the lane to the body's 16x12, connect the room, or\n" +
      "mark the cell solid (Rebuild collision in the builder does this).",
  );
}

// ---- 3. art over void ------------------------------------------------------
function checkVoid(layout, painted, silhouette, nodes) {
  const { width: W, height: H } = layout;
  const offenders = [];
  for (const node of nodes) {
    const { left, top } = frameAt(node);
    let worst = 0;
    for (let y = 0; y < FRAME_H; y++) {
      for (let x = 0; x < FRAME_W; x++) {
        if (!silhouette.opaque[y * FRAME_W + x]) continue;
        const wx = left + x;
        const wy = top + y;
        // off-canvas is void too — there is certainly no room out there
        if (wx < 0 || wy < 0 || wx >= W || wy >= H || !painted[wy * W + wx]) worst++;
      }
    }
    if (worst > 0) offenders.push({ ...node, px: worst });
  }
  offenders.sort((a, b) => b.px - a.px);
  const total = FRAME_W * FRAME_H;
  console.log(`checked: ${nodes.length} reachable standing positions`);
  report(
    "position(s) where the player's art hangs over nothing",
    "nowhere the player can stand shows their art against the void",
    offenders,
    (o) =>
      `${at(o)}  ${String(o.px).padStart(4)} px of sprite over void  (${((o.px / total) * 100).toFixed(1)}% of frame)`,
    "The art and the collision grid disagree here. Either the lane is opened too close\n" +
      "to a tile whose opaque face sits inboard of its cell, or the room has no backdrop\n" +
      "there. Fix the layout's collision, not the body box.",
  );
}

// ---- 4. face occlusion -----------------------------------------------------
function checkOcclusion(layout, sprites, silhouette) {
  const hidden = hiddenNodes(walkGridOf(layout), layout.spawn, sprites, silhouette);
  report(
    "position(s) where the player's face is painted over",
    "nowhere the player can stand hides their face behind the room",
    hidden,
    (h) => `${at(h.node)}  ${(h.covered * 100).toFixed(0)}% of the face covered`,
    "Something the scene draws in front of the character covers their face here: a\n" +
      "lane behind a tall object whose floor line is south of it, or an overhead prop\n" +
      "over walkable floor. The scene seals these spots at boot; fix the data so it\n" +
      "does not have to: mark the cell solid, move the object, or lower its layer.",
  );
}

async function main() {
  const layout = parseOfficeLayout(JSON.parse(readFileSync(layoutPath, "utf8")));
  console.log(`layout : ${path.relative(appRoot, layoutPath)}`);

  checkReachability(layout);
  checkPockets(layout);

  const nodes = reachableNodes(walkGridOf(layout), layout.spawn);

  const sprites = await paintedSprites(layout);
  const silhouette = await characterSilhouette();
  checkVoid(layout, paintedMask(layout, sprites), silhouette, nodes);
  checkOcclusion(layout, sprites, silhouette);
}
void main();
