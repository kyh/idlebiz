// Standalone compositor: renders the office layout to a flat 512x544 PNG that
// can be diffed directly against 6_Office_Designs/Office_Design_2.gif.
// Mirrors OfficeScene rendering: floor/wall tiles, then objects y-sorted by the
// bottom edge of their opaque content. No Electron / Phaser required.
//
// Usage: node scripts/render-office-preview.cjs [out.png] [--layout path.json]
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const appRoot = path.resolve(__dirname, "..");
const kit = path.join(appRoot, "public/workspace-kit");
const args = process.argv.slice(2);
const layoutFlag = args.indexOf("--layout");
const layoutPath =
  layoutFlag >= 0
    ? path.resolve(args[layoutFlag + 1])
    : path.join(appRoot, "src/renderer/game/office-design.json");
const outPath = path.resolve(
  args.find((a, i) => !a.startsWith("--") && i !== layoutFlag + 1) || "/tmp/office_render.png",
);

const boundsCache = new Map();
async function objectBounds(file) {
  if (boundsCache.has(file)) return boundsCache.get(file);
  const img = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = img.info;
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (img.data[(y * w + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const b = maxX < minX ? { x: 0, y: 0, w, h } : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  boundsCache.set(file, b);
  return b;
}

function objectPath(id) {
  return path.join(kit, "office-objects/32", `modern-office-32-${id.replace("office-object-", "")}.png`);
}
function floorTile(kind) {
  const file = kind === "wood" ? "floor-wood.png" : kind === "plank" ? "floor-plank.png" : "floor-gray.png";
  return path.join(kit, "office-tiles", file);
}
function wallTile(kind) {
  return path.join(kit, "office-tiles", kind === "brick" ? "wall-brick.png" : "wall-paper.png");
}

async function tiledRect(tileFile, w, h) {
  // tile a sheet rounded up to whole 32px tiles, then crop to the exact rect
  // (Phaser tileSprite clips partial tiles the same way).
  const sw = Math.ceil(w / 32) * 32;
  const sh = Math.ceil(h / 32) * 32;
  const sheet = await sharp({
    create: { width: sw, height: sh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: tileFile, tile: true, top: 0, left: 0 }])
    .png()
    .toBuffer();
  return sharp(sheet).extract({ left: 0, top: 0, width: w, height: h }).png().toBuffer();
}

async function main() {
  const layout = JSON.parse(fs.readFileSync(layoutPath, "utf8"));
  const W = layout.width,
    H = layout.height;
  const layers = [];

  for (const z of layout.floorZones) {
    layers.push({ depth: 0, input: await tiledRect(floorTile(z.kind), z.w, z.h), left: z.x, top: z.y });
  }
  for (const r of layout.wallRects) {
    layers.push({ depth: 5, input: await tiledRect(wallTile(r.kind), r.w, r.h), left: r.x, top: r.y });
  }
  // objects: depth mirrors office-layout.ts depthFor exactly (floor decals
  // scale anchorY by 1e-4 so boosted anchors can never cross into the object
  // band; the +0.5 biases furniture to win ties against actors).
  const objLayers = [];
  for (const o of layout.objects) {
    const file = o.path ? path.join(appRoot, "public", o.path) : objectPath(o.id);
    const b = await objectBounds(file);
    const anchor = typeof o.anchorY === "number" ? o.anchorY : o.y + b.y + b.h;
    const depth =
      o.layer === "floor" ? 10 + anchor * 1e-4 : o.layer === "overhead" ? 1_000_000 + anchor : 1000 + anchor + 0.5;
    objLayers.push({ depth, input: file, left: o.x, top: o.y });
  }
  objLayers.sort((a, b) => a.depth - b.depth);
  layers.push(...objLayers);

  // room shell outlines (drawn on top), matches drawOfficeShell
  const shellSvg = [`<svg width="${W}" height="${H}">`];
  for (const room of layout.shellRooms || []) {
    shellSvg.push(
      `<rect x="${room.x}" y="${room.y}" width="${room.w}" height="${room.h}" fill="none" stroke="#1d2136" stroke-width="4"/>`,
      `<rect x="${room.x + 6}" y="${room.y + 6}" width="${room.w - 12}" height="${room.h - 12}" fill="none" stroke="#f7f4fb" stroke-width="2"/>`,
    );
  }
  shellSvg.push(`</svg>`);
  if ((layout.shellRooms || []).length) {
    layers.push({ depth: Number.MAX_SAFE_INTEGER, input: Buffer.from(shellSvg.join("")), left: 0, top: 0 });
  }

  const composite = layers
    .toSorted((a, b) => a.depth - b.depth)
    .map(({ input, left, top }) => ({ input, left: Math.round(left), top: Math.round(top) }));

  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0x14, g: 0x16, b: 0x1f, alpha: 1 } } })
    .composite(composite)
    .png()
    .toFile(outPath);
  console.log(`rendered ${composite.length} layers -> ${outPath}`);
}
void main();
