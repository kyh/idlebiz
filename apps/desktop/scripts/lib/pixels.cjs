const sharp = require("sharp");

/** Decode a PNG to raw RGBA. */
const loadRaw = async (file) => {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, h: info.height, w: info.width };
};

/** Bounding box of the non-transparent pixels ({x,y,w,h}); full canvas if blank. */
const opaqueBounds = (img) => {
  let minX = img.w;
  let minY = img.h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.h; y += 1) {
    for (let x = 0; x < img.w; x += 1) {
      if (img.data[(y * img.w + x) * 4 + 3] === 0) {
        continue;
      }
      if (x < minX) {
        minX = x;
      }
      if (x > maxX) {
        maxX = x;
      }
      if (y < minY) {
        minY = y;
      }
      if (y > maxY) {
        maxY = y;
      }
    }
  }
  if (maxX < minX) {
    return { h: img.h, w: img.w, x: 0, y: 0 };
  }
  return { h: maxY - minY + 1, w: maxX - minX + 1, x: minX, y: minY };
};

module.exports = { loadRaw, opaqueBounds };
