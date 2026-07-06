// Standalone compositor: renders the office layout to a flat 512x544 PNG that
// can be diffed directly against 6_Office_Designs/Office_Design_2.gif.
// Mirrors the office scene rendering: placed objects y-sorted exactly like
// depthFor in office-layout.ts. No Electron / Phaser required.
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

const { loadRaw, opaqueBounds } = require("./lib/pixels.cjs");

const boundsCache = new Map();
async function objectBounds(file) {
  if (boundsCache.has(file)) return boundsCache.get(file);
  const b = opaqueBounds(await loadRaw(file));
  boundsCache.set(file, b);
  return b;
}

function objectPath(id) {
  return path.join(kit, "office-objects/32", `modern-office-32-${id.replace("office-object-", "")}.png`);
}
async function main() {
  const layout = JSON.parse(fs.readFileSync(layoutPath, "utf8"));
  const W = layout.width,
    H = layout.height;
  const layers = [];
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
