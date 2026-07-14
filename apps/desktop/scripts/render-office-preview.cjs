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
const args = process.argv.slice(2);
const layoutFlag = args.indexOf("--layout");
const layoutPath =
  layoutFlag >= 0
    ? path.resolve(args[layoutFlag + 1])
    : path.join(appRoot, "src/renderer/game/office-design.json");
// the positional arg is the out path; skip flags and the value --layout consumes
const outPath = path.resolve(
  args.find((a, i) => !a.startsWith("--") && !(layoutFlag >= 0 && i === layoutFlag + 1)) ||
    "/tmp/office_render.png",
);

const { objectFile } = require("./lib/office-assets.cjs");
const { paintOrder } = require("./lib/depth.cjs");

async function main() {
  const layout = JSON.parse(fs.readFileSync(layoutPath, "utf8"));
  const W = layout.width,
    H = layout.height;

  const composite = [];
  for (const { obj } of paintOrder(layout.objects)) {
    const file = objectFile(appRoot, obj);
    let input = file;
    if (obj.flipX || obj.flipY) {
      let img = sharp(file);
      if (obj.flipX) img = img.flop();
      if (obj.flipY) img = img.flip();
      input = await img.png().toBuffer();
    }
    composite.push({ input, left: Math.round(obj.x), top: Math.round(obj.y) });
  }

  await sharp({
    create: {
      width: W,
      height: H,
      channels: 4,
      background: { r: 0x14, g: 0x16, b: 0x1f, alpha: 1 },
    },
  })
    .composite(composite)
    .png()
    .toFile(outPath);
  console.log(`rendered ${composite.length} layers -> ${outPath}`);
}
void main();
