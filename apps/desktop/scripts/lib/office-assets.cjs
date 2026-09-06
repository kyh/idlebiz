// Decoded sprites for the office gate, one read per file.
const { loadRaw, opaqueBounds } = require("./pixels.cjs");

const cache = new Map();
/** Raw RGBA + opaque bounds for a sprite file, decoded once per run. */
async function sprite(file) {
  const hit = cache.get(file);
  if (hit) return hit;
  const img = await loadRaw(file);
  const loaded = { ...img, bounds: opaqueBounds(img) };
  cache.set(file, loaded);
  return loaded;
}

module.exports = { sprite };
