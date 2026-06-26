// Parametric PLAYABLE tilemap, tuned to look as close as possible to the dense
// Office_Design_2 reference while keeping real character-width lanes.
// Edit the grid/rooms and re-run: `node scripts/generate-office-layout.cjs [outPath]`.
const fs = require("fs");
const path = require("node:path");
const sharp = require("sharp");

const appRoot = path.resolve(__dirname, "..");
const objDir = path.join(appRoot, "public/workspace-kit/office-objects/32");
const outPath = process.argv[2] || path.join(appRoot, "src/renderer/game/office-design.json");

const TILE = 32, CELL = 16;
const WIDTH = 512, HEIGHT = 544;
const C_COLS = WIDTH / CELL, C_ROWS = HEIGHT / CELL;

const mc = new Map();
async function metrics(id) {
  const k = String(id).padStart(3, "0");
  if (mc.has(k)) return mc.get(k);
  const img = await sharp(path.join(objDir, `modern-office-32-${k}.png`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = img.info;
  let minX = w, minY = h, maxX = -1, maxY = -1, sb = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = img.data[(y * w + x) * 4 + 3]; if (a <= 40) continue; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; if (a > 180 && y > sb) sb = y; }
  const m = { bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, solidBottom: sb < 0 ? maxY : sb };
  mc.set(k, m); return m;
}

const objects = [], seats = [];
const collision = Array.from({ length: C_ROWS }, () => Array.from({ length: C_COLS }, () => 0));
const paint = (px, py, pw, ph) => { const c0 = Math.max(0, Math.floor(px / CELL)), r0 = Math.max(0, Math.floor(py / CELL)), c1 = Math.min(C_COLS, Math.ceil((px + pw) / CELL)), r1 = Math.min(C_ROWS, Math.ceil((py + ph) / CELL)); for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) collision[r][c] = 1; };
const clear = (px, py, pw, ph) => { const c0 = Math.max(0, Math.floor(px / CELL)), r0 = Math.max(0, Math.floor(py / CELL)), c1 = Math.min(C_COLS, Math.ceil((px + pw) / CELL)), r1 = Math.min(C_ROWS, Math.ceil((py + ph) / CELL)); for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) collision[r][c] = 0; };
async function place(id, cx, cy, layer, opts = {}) {
  const m = await metrics(id);
  objects.push({ id: `office-object-${String(id).padStart(3, "0")}`, x: Math.round(cx - m.bbox.x), y: Math.round(cy - m.bbox.y), layer, anchorY: Math.round(cy - m.bbox.y) + m.solidBottom });
  if (opts.solid) paint(cx + opts.solid.x, cy + opts.solid.y, opts.solid.w, opts.solid.h);
  return m;
}

async function main() {
  const ROOM_TOP = 12 * TILE; // 384
  const floorZones = [
    { x: 0, y: TILE, w: WIDTH, h: ROOM_TOP - TILE, kind: "gray" },
    { x: 0, y: ROOM_TOP, w: WIDTH / 2, h: HEIGHT - ROOM_TOP, kind: "plank" },
    { x: WIDTH / 2, y: ROOM_TOP, w: WIDTH / 2, h: HEIGHT - ROOM_TOP, kind: "wood" },
  ];
  const wallRects = [
    { x: 0, y: 0, w: WIDTH, h: TILE, kind: "paper" },
    { x: 0, y: ROOM_TOP - TILE / 2, w: WIDTH, h: TILE / 2, kind: "brick" },
  ];
  paint(0, 0, WIDTH, TILE);
  paint(0, ROOM_TOP - TILE / 2, WIDTH, TILE / 2);

  // === DENSE CUBICLE FARM, matching the reference composition per cubicle:
  // light back partition wall (208) + gray desk w/ dual monitor (230/231) + dark
  // high-back chair (105/106) in front. Packed columns, lanes between blocks.
  const WS = [230, 231];
  const CH = [105, 106];
  const dm0 = await metrics(230);
  const cubW = dm0.bbox.w; // ~64
  const colX = [24, 96, 188, 260, 352, 424]; // 3 blocks of 2; ~28px walkable lanes between blocks + margins
  const rowY = [40, 150, 260]; // 3 rows; bottom clears the divider wall
  let i = 0;
  for (const ry of rowY) {
    for (const cx of colX) {
      const ws = WS[i % WS.length], ch = CH[i % CH.length]; i++;
      const dm = await metrics(ws);
      await place(208, cx - 2, ry - 8, "object"); // light partition back wall
      await place(207, cx + dm.bbox.w - 3, ry - 6, "object"); // vertical cubicle divider
      await place(ws, cx, ry, "object", { solid: { x: 1, y: 1, w: dm.bbox.w - 2, h: dm.bbox.h } }); // desk+monitor solid
      if (i % 3 === 0) await place(144, cx + dm.bbox.w - 18, ry - 2, "object"); // desk lamp on some
      const chm = await metrics(ch);
      const chx = cx + dm.bbox.w / 2 - chm.bbox.w / 2;
      await place(ch, chx, ry + dm.bbox.h + 2, "object"); // dark chair in front
      seats.push({ x: Math.round(cx + dm.bbox.w / 2), y: Math.round(ry + dm.bbox.h + chm.bbox.h + 6) });
    }
  }
  void cubW;

  // === TOP-WALL DECOR (on the wall, behind actors) ===
  await place(163, 16, 2, "object");
  await place(97, 92, 4, "object");
  await place(170, 170, 2, "object"); // whiteboard centre
  await place(171, 300, 2, "object"); // chart
  await place(99, 392, 0, "object");
  await place(156, 452, 4, "object"); // printer

  // aisle plants
  await place(338, 116, 110, "object");
  await place(338, 356, 208, "object");
  await place(137, 232, 110, "object");

  // === BREAK ROOM (bottom-left) ===
  const L = { x: 0, y: ROOM_TOP };
  await place(282, L.x + 86, L.y + 64, "floor");
  await place(175, L.x + 14, L.y + 8, "object", { solid: { x: 2, y: 24, w: 40, h: 26 } });
  const tm = await metrics(220);
  const tx = L.x + 100, ty = L.y + 80;
  await place(140, tx + tm.bbox.w / 2 - 14, ty - 26, "object");
  await place(220, tx, ty, "object", { solid: { x: 2, y: 6, w: tm.bbox.w - 4, h: tm.bbox.h - 10 } });
  await place(142, tx + tm.bbox.w / 2 - 14, ty + tm.bbox.h - 6, "object");
  await place(137, L.x + 14, L.y + 120, "object");
  await place(99, L.x + 206, L.y + 108, "object");

  // === MANAGER OFFICE (bottom-right) ===
  const M = { x: WIDTH / 2, y: ROOM_TOP };
  const dm = await metrics(300);
  await place(300, M.x + 44, M.y + 40, "object", { solid: { x: 4, y: 8, w: dm.bbox.w - 8, h: dm.bbox.h - 12 } });
  await place(130, M.x + 66, M.y + 28, "object");
  await place(147, M.x + 74, M.y + 96, "object");
  await place(99, M.x + 200, M.y + 100, "object");
  await place(335, M.x + 10, M.y + 6, "object");
  seats.push({ x: Math.round(M.x + 60), y: Math.round(M.y + 150) });

  // doorways through the divider wall into each room
  clear(120, ROOM_TOP - TILE / 2, 56, TILE / 2);
  clear(360, ROOM_TOP - TILE / 2, 56, TILE / 2);

  const order = { floor: 0, object: 1, overhead: 2 };
  objects.sort((a, b) => order[a.layer] - order[b.layer] || a.anchorY - b.anchorY);
  const layout = { tile: TILE, width: WIDTH, height: HEIGHT, cell: CELL, cols: C_COLS, rows: C_ROWS, spawn: { x: WIDTH / 2, y: ROOM_TOP - 40 }, floorZones, wallRects, objects, collision: collision.map((r) => r.join("")), workSeats: seats };
  fs.writeFileSync(outPath, JSON.stringify(layout, null, 2));
  console.log(`wrote ${objects.length} objects, ${seats.length} seats -> ${outPath}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
