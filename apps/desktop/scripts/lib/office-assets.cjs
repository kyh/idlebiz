// Resolving a placed object back to the PNG the renderer loads for it.
const path = require("node:path");
const { loadRaw, opaqueBounds } = require("./pixels.cjs");

/** The sprite a placement draws: an explicit path, else the 32px catalog single. */
function objectFile(appRoot, obj) {
  if (obj.path) return path.join(appRoot, "public", obj.path);
  return path.join(
    appRoot,
    "public/workspace-kit/office-objects/32",
    `modern-office-32-${obj.id.replace("office-object-", "")}.png`,
  );
}

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

module.exports = { objectFile, sprite };
