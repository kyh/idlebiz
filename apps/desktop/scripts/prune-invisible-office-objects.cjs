// Deletes placed objects that the player can never see.
//
// The office was assembled by decomposing a reference render, so it carries the
// pack's own hidden geometry: whole desks buried under other desks, wall tiles
// behind wall tiles, decals under furniture. They cost a texture and a draw call
// each and they make the layout unreadable to anyone editing it by hand.
//
// An object is INVISIBLE when every one of its opaque pixels is covered by a
// fully-opaque pixel of an object painted above it. That test is exact for a
// static scene, and objects only ever occlude each other -- an actor walking by
// can only cover MORE. So dropping them is a no-op for the composite, which is
// the check this script enforces before it writes: prune, re-render, and refuse
// unless the image is byte-identical.
//
// The shipped office-design.json is now hand-authored; this ran as pass 4 of the pipeline
// that seeded it (generate -> remove-people -> relax -> prune). It rewrites the live layout
// in place — diff before you commit.
//
// Usage: node scripts/prune-invisible-office-objects.cjs [--write]
const path = require("node:path");

const { objectFile, sprite } = require("./lib/office-assets.cjs");
const { paintOrder } = require("./lib/depth.cjs");
const { readLayout, writeLayout } = require("./lib/office-layout-file.cjs");

const appRoot = path.resolve(__dirname, "..");
const write = process.argv.includes("--write");

const OPAQUE = 255;

async function main() {
  const layout = readLayout();
  const { width: W, height: H } = layout;
  const order = paintOrder(layout.objects);

  // Per pixel: the paint-order slot of the topmost fully-opaque object covering it.
  // Anything painted below that slot is sealed off at that pixel.
  const sealedBy = new Int32Array(W * H).fill(-1);
  const masks = [];

  for (let slot = 0; slot < order.length; slot++) {
    const { obj } = order[slot];
    const img = await sprite(objectFile(appRoot, obj));
    const mask = { slot, obj, px: [] };
    for (let sy = 0; sy < img.h; sy++) {
      for (let sx = 0; sx < img.w; sx++) {
        // flips move the sampled source pixel, not the destination canvas
        const srcX = obj.flipX ? img.w - 1 - sx : sx;
        const srcY = obj.flipY ? img.h - 1 - sy : sy;
        const alpha = img.data[(srcY * img.w + srcX) * 4 + 3];
        if (alpha === 0) continue;
        const x = Math.round(obj.x) + sx;
        const y = Math.round(obj.y) + sy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue; // clipped off-canvas
        const p = y * W + x;
        mask.px.push(p);
        if (alpha === OPAQUE) sealedBy[p] = slot;
      }
    }
    masks.push(mask);
  }

  const invisible = [];
  for (const mask of masks) {
    // visible iff some pixel of it is not sealed by anything painted above it
    const seen = mask.px.some((p) => sealedBy[p] <= mask.slot);
    if (!seen) invisible.push(mask);
  }

  const byId = new Map();
  for (const m of invisible) byId.set(m.obj.id, (byId.get(m.obj.id) ?? 0) + 1);
  console.log(`${invisible.length} of ${layout.objects.length} objects are never visible`);
  for (const [id, n] of [...byId].toSorted((a, b) => b[1] - a[1])) console.log(`  ${n}x ${id}`);
  if (!invisible.length || !write) {
    if (!write) console.log("\n(dry run -- pass --write to prune)");
    return;
  }

  const drop = new Set(invisible.map((m) => m.obj));
  const kept = layout.objects.filter((obj) => !drop.has(obj));
  writeLayout({ ...layout, objects: kept });
  console.log(`\npruned ${layout.objects.length} -> ${kept.length} objects`);
  console.log("now verify: render-office-preview must be byte-identical to the pre-prune render");
}
void main();
