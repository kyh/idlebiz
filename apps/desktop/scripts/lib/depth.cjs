// Draw-order math for the office layout, for the node-side asset scripts.
//
// MUST stay in lockstep with the renderer: DEPTH in src/renderer/game/config.ts
// and depthFor() in src/renderer/game/office-layout.ts. A script that sorts
// differently than the game is worse than no script — it reports occlusion that
// doesn't happen and misses occlusion that does.
const DEPTH = { ground: 0, entityBase: 1000, overhead: 2000, emote: 3000 };
const STACK_STEP = 1e-3;

/** Draw depth of the object at `index` in the paint-ordered array. */
function depthFor(obj, index) {
  if (obj.layer === "floor") return DEPTH.ground + STACK_STEP * (index + 1);
  if (obj.layer === "overhead") return DEPTH.overhead + STACK_STEP * (index + 1);
  return DEPTH.entityBase + obj.anchorY + 0.5;
}

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

module.exports = { DEPTH, STACK_STEP, depthFor, paintOrder };
