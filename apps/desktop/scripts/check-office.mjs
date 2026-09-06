// Checks reachability, floor pockets, sprite overhang and face occlusion using
// the same geometry as the game. Art and collision are authored independently.
// Usage: node scripts/check-office.mjs [--layout path.json] [--sheet path.png]
// Exit 0 = clean, 1 = invalid layout.
import path from "node:path";
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
import { loadRaw } from "./lib/pixels.cjs";

const appRoot = path.resolve(import.meta.dirname, "..");

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
  const masks = new Map();
  for (const obj of layout.objects.toSorted(comparePaintOrder)) {
    const file = path.join(appRoot, "public", objectSpritePath(obj));
    let mask = masks.get(file);
    if (!mask) {
      mask = maskOf(await loadRaw(file));
      masks.set(file, mask);
    }
    out.push({ obj, mask });
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
    at,
    "Open floor nobody can reach reads as a place to go, and the nodes beside it stand\n" +
      "half inside furniture. Widen the lane to the body's 16x12, connect the room, or\n" +
      "mark the cell solid (Rebuild collision in the builder does this).",
  );
}

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
