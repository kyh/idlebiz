// Draw-order math for the office layout, for the node-side asset scripts.
//
// MUST stay in lockstep with how the renderer paints — DEPTH in
// src/shared/office-depth.ts and depthFor() in
// src/renderer/game/office-layout.ts. A script that sorts differently than the
// game is worse than no script — it reports occlusion that doesn't happen and
// misses occlusion that does.

const BAND = { floor: 0, object: 1, overhead: 2 };

/**
 * Objects in the order the renderer paints them, back to front.
 *
 * Bands stack; within the entity band, objects y-sort on anchorY. The ground and
 * overhead bands have no sort key at all — they keep the order they were authored
 * in, so this sort must stay STABLE (Array#sort is, in V8).
 */
function paintOrder(objects) {
  return objects
    .map((obj, index) => ({ obj, index }))
    .toSorted(
      (a, b) =>
        BAND[a.obj.layer] - BAND[b.obj.layer] ||
        (a.obj.layer === "object" && b.obj.layer === "object"
          ? a.obj.anchorY - b.obj.anchorY
          : 0) ||
        a.index - b.index,
    );
}

module.exports = { paintOrder };
