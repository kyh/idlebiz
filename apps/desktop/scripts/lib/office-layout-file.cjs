// Reading and writing office-design.json the way the game expects it.
const fs = require("node:fs");
const path = require("node:path");
const { paintOrder } = require("./depth.cjs");

const LAYOUT_PATH = path.resolve(__dirname, "../../src/renderer/game/office-design.json");

function readLayout(file = LAYOUT_PATH) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Write a layout in the game's canonical form: objects in paint order, and an
 * anchorY only on the layer that has a floor line to anchor to. The flat bands
 * (ground, overhead) draw in array order, so the order IS the data — a script
 * that emits objects in some other order silently reshuffles the room.
 */
function writeLayout(layout, file = LAYOUT_PATH) {
  const objects = paintOrder(layout.objects).map(({ obj }) => {
    const out = { id: obj.id, x: obj.x, y: obj.y, layer: obj.layer };
    if (obj.layer === "object") out.anchorY = obj.anchorY;
    if (obj.path) out.path = obj.path;
    if (obj.flipX) out.flipX = true;
    if (obj.flipY) out.flipY = true;
    return out;
  });
  fs.writeFileSync(file, `${JSON.stringify({ ...layout, objects }, null, 2)}\n`);
  return objects.length;
}

const BAND = { floor: 0, object: 1, overhead: 2 };

/**
 * Freeze a legacy anchor-sorted object list into paint order.
 *
 * The generator uses anchorY as a working sort key on EVERY layer (10_000+ for a
 * floor decal, 900_000+ for one it had to escalate). That's fine as an internal
 * device, but the shipped model has no anchor outside the entity band — the flat
 * bands are ordered by the array itself. So the sort key has to be spent here, at
 * the boundary, and writeLayout then drops it where it no longer means anything.
 */
function canonicalizeLegacyAnchors(objects) {
  return objects
    .map((obj, index) => ({ obj, index }))
    .toSorted(
      (a, b) =>
        BAND[a.obj.layer] - BAND[b.obj.layer] || a.obj.anchorY - b.obj.anchorY || a.index - b.index,
    )
    .map(({ obj }) => obj);
}

module.exports = { LAYOUT_PATH, readLayout, writeLayout, canonicalizeLegacyAnchors };
