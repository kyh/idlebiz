// Decompose the Office_Design_2 reference (6_Office_Designs) into exact object
// placements by occlusion-aware template matching of the Modern_Office singles
// (16x16 scale) plus tile matching (arbitrary offsets, multiple source sheets)
// for walls/floors — the design's structure mixes the revamped Room_Builder,
// the previous-version office walls/floors, and Modern Interiors sheets.
//
// The reference was composed with sprite versions that drift from the shipped
// singles by a few gray levels in small patches (measured: desks differ on
// ~24/256 pixels by 1-12 levels), so matching tolerates a small fraction of
// mismatched pixels and picks the best-scoring sprite per position.
//
// Input: a flattened reference PNG (furniture+structure layers, NO people).
// Output: JSON with {objects:[{id,x,y,pass}], tiles:[{id,x,y,pass}]} at
// source (16px) scale, plus a recomposite PNG + diff count vs the reference.
//
// Usage: node scripts/decompose-office-reference.cjs <ref_flat.png> <out.json> [recomposite.png]
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { loadRaw } = require("./lib/pixels.cjs");

const VG = "/Users/kyh/Desktop/vg/office";
const PACK = path.join(VG, "Modern_Office_Revamped_v1.2");
const SINGLES_DIR = path.join(PACK, "4_Modern_Office_singles/16x16");
const CELL = 16;

// 16px structure sheets, each with a 2x (32px) counterpart used by the game.
// Order matters: earlier sheets win content-identical tiles.
const TILE_SOURCES = [
  { key: "rbo", file: path.join(PACK, "1_Room_Builder_Office/Room_Builder_Office_16x16.png") },
  {
    key: "ow",
    file: path.join(PACK, "7_Modern_Office_Previous_Version/Modern_Office_old/Office_walls_floors_16x16.png"),
  },
  { key: "mirb", file: path.join(VG, "moderninteriors-win/1_Interiors/16x16/Room_Builder_16x16.png") },
];

// Previous-version interiors sheet: objects sliced by connected components
// (the design predates the revamp, so some props only exist there).
const OLD_INTERIORS = path.join(
  PACK,
  "7_Modern_Office_Previous_Version/Modern_Office_old/Office_interiors_16x16.png",
);
// Modern Interiors objects (same artist): the design borrows props from it
// (shelf contents like the aquarium/books are MI objects).
const MI_INTERIORS = path.join(VG, "moderninteriors-win/1_Interiors/16x16/Interiors_16x16.png");

const MIN_EXACT = 0.88; // ≥88% of opaque pixels exact (tolerates palette drift)
const OBJ_MIN_FRESH_FRAC = 0.35; // objects: enough fresh evidence to kill ghosts
const TILE_MIN_FRESH_FRAC = 0.04; // tiles: floors legitimately peek through gaps
const MIN_FRESH_PX = 12;

function rgbEq(a, ao, b, bo) {
  return a[ao] === b[bo] && a[ao + 1] === b[bo + 1] && a[ao + 2] === b[bo + 2];
}

function buildMasks(img) {
  const opaque = []; // x, y, byteOffset triples of fully solid pixels
  const anyAlpha = []; // x, y pairs of every non-transparent pixel (claim mask)
  let bx0 = img.w, by0 = img.h, bx1 = -1, by1 = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const o = (y * img.w + x) * 4;
      if (img.data[o + 3] === 255) opaque.push(x, y, o);
      if (img.data[o + 3] > 0) {
        anyAlpha.push(x, y);
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
  }
  return { opaque, anyAlpha, bbox: { bx0, by0, bx1, by1 } };
}

/** Horizontally mirrored copy of a raw image. */
function flipXRaw(img) {
  const data = Buffer.alloc(img.data.length);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const src = (y * img.w + x) * 4;
      const dst = (y * img.w + (img.w - 1 - x)) * 4;
      img.data.copy(data, dst, src, src + 4);
    }
  }
  return { data, w: img.w, h: img.h };
}

/** Register a template plus its mirrored variant (deduped by content — a
 * symmetric sprite or one whose mirror ships as its own asset adds nothing). */
function pushWithFlip(list, byContent, base) {
  const contentKey = Buffer.from(base.data).toString("base64");
  if (byContent.has(contentKey)) return byContent.get(contentKey);
  byContent.set(contentKey, base);
  list.push(base);
  const flippedImg = flipXRaw(base);
  const flipKey = Buffer.from(flippedImg.data).toString("base64");
  if (!byContent.has(flipKey)) {
    const masks = buildMasks(flippedImg);
    const flipped = {
      ...base,
      data: flippedImg.data,
      opaque: masks.opaque,
      anyAlpha: masks.anyAlpha,
      bbox: masks.bbox,
      flipX: true,
    };
    byContent.set(flipKey, flipped);
    list.push(flipped);
  }
  return base;
}

async function loadSprites() {
  const files = fs.readdirSync(SINGLES_DIR).filter((f) => f.endsWith(".png"));
  const sprites = [];
  const byContent = new Map();
  for (const f of files) {
    const m = /_(\d+)\.png$/.exec(f);
    if (!m) continue;
    const img = await loadRaw(path.join(SINGLES_DIR, f));
    const { opaque, anyAlpha, bbox } = buildMasks(img);
    if (opaque.length === 0) continue;
    const sprite = { id: `obj-${m[1]}`, w: img.w, h: img.h, data: img.data, opaque, anyAlpha, bbox, aliases: [], flipX: false };
    const kept = pushWithFlip(sprites, byContent, sprite);
    if (kept !== sprite) kept.aliases.push(Number(m[1]));
  }
  sprites.sort((a, b) => b.opaque.length - a.opaque.length);
  return sprites;
}

// Slice a sheet into connected components of non-transparent pixels
// (8-connected), each exported as a template with its own bbox-local canvas.
async function loadComponents(file, keyPrefix) {
  const img = await loadRaw(file);
  const seen = new Uint8Array(img.w * img.h);
  const comps = [];
  const compContent = new Map();
  for (let y0 = 0; y0 < img.h; y0++) {
    for (let x0 = 0; x0 < img.w; x0++) {
      const idx0 = y0 * img.w + x0;
      if (seen[idx0] || img.data[idx0 * 4 + 3] === 0) continue;
      const stack = [idx0];
      seen[idx0] = 1;
      const px = [];
      let minX = x0, maxX = x0, minY = y0, maxY = y0;
      while (stack.length) {
        const idx = stack.pop();
        const x = idx % img.w;
        const y = (idx / img.w) | 0;
        px.push(idx);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= img.w || ny >= img.h) continue;
            const nidx = ny * img.w + nx;
            if (seen[nidx] || img.data[nidx * 4 + 3] === 0) continue;
            seen[nidx] = 1;
            stack.push(nidx);
          }
        }
      }
      if (px.length < 12) continue;
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      const data = Buffer.alloc(w * h * 4);
      for (const idx of px) {
        const x = idx % img.w;
        const y = (idx / img.w) | 0;
        img.data.copy(data, ((y - minY) * w + (x - minX)) * 4, idx * 4, idx * 4 + 4);
      }
      const comp = { id: `${keyPrefix}-${minX}-${minY}`, w, h, data, aliases: [], srcRect: { x: minX, y: minY, w, h }, flipX: false };
      const masks = buildMasks(comp);
      if (masks.opaque.length === 0) continue;
      comp.opaque = masks.opaque;
      comp.anyAlpha = masks.anyAlpha;
      comp.bbox = masks.bbox;
      pushWithFlip(comps, compContent, comp);
    }
  }
  return comps;
}

async function loadTiles() {
  const tiles = [];
  const byContent = new Map();
  for (const src of TILE_SOURCES) {
    const img = await loadRaw(src.file);
    const cols = Math.floor(img.w / CELL);
    const rows = Math.floor(img.h / CELL);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const data = Buffer.alloc(CELL * CELL * 4);
        for (let y = 0; y < CELL; y++) {
          img.data.copy(data, y * CELL * 4, ((r * CELL + y) * img.w + c * CELL) * 4, ((r * CELL + y) * img.w + (c + 1) * CELL) * 4);
        }
        const tile = { id: `${src.key}-${c}-${r}`, w: CELL, h: CELL, data, aliases: [], flipX: false };
        const masks = buildMasks(tile);
        if (masks.opaque.length < 24) continue;
        tile.opaque = masks.opaque;
        tile.anyAlpha = masks.anyAlpha;
        tile.bbox = masks.bbox;
        pushWithFlip(tiles, byContent, tile);
      }
    }
  }
  return tiles;
}

function scoreAt(sprite, sx, sy, ref, explained, minFreshFrac, minExact = MIN_EXACT) {
  const { opaque } = sprite;
  const total = opaque.length / 3;
  const misBudget = Math.floor(total * (1 - minExact));
  let exact = 0;
  let fresh = 0;
  let mis = 0;
  for (let i = 0; i < opaque.length; i += 3) {
    const x = sx + opaque[i];
    const y = sy + opaque[i + 1];
    if (x < 0 || y < 0 || x >= ref.w || y >= ref.h) return null;
    const idx = y * ref.w + x;
    const ro = idx * 4;
    if (ref.data[ro + 3] === 255 && rgbEq(ref.data, ro, sprite.data, opaque[i + 2])) {
      exact++;
      if (!explained[idx]) fresh++;
    } else if (!explained[idx]) {
      mis++;
      if (mis > misBudget) return null;
    }
  }
  if (fresh < MIN_FRESH_PX || fresh / total < minFreshFrac) return null;
  return { fresh, mis, total };
}

function claim(sprite, sx, sy, ref, explained) {
  const { anyAlpha } = sprite;
  for (let i = 0; i < anyAlpha.length; i += 2) {
    const x = sx + anyAlpha[i];
    const y = sy + anyAlpha[i + 1];
    if (x >= 0 && y >= 0 && x < ref.w && y < ref.h) explained[y * ref.w + x] = 1;
  }
}

// Integral image of unexplained-opaque pixels for cheap position pruning.
function buildUnexplainedIntegral(ref, explained) {
  const { w, h } = ref;
  const I = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!explained[idx] && ref.data[idx * 4 + 3] === 255) rowSum++;
      I[(y + 1) * (w + 1) + (x + 1)] = I[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  return (x0, y0, x1, y1) => {
    // unexplained count in [x0,x1) x [y0,y1)
    const W = ref.w + 1;
    return I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
  };
}

function runPasses(label, templates, ref, explained, out, minFreshFrac, maxPasses, minExact = MIN_EXACT) {
  for (let pass = 1; pass <= maxPasses; pass++) {
    const unexplainedIn = buildUnexplainedIntegral(ref, explained);
    const candidates = [];
    for (const t of templates) {
      const need = Math.max(MIN_FRESH_PX, Math.ceil((t.opaque.length / 3) * minFreshFrac));
      // padded sprite canvases may hang off the map as long as their content
      // bbox stays inside (the top-wall decor sits at negative canvas y)
      for (let sy = -t.bbox.by0; sy <= ref.h - t.bbox.by1 - 1; sy++) {
        for (let sx = -t.bbox.bx0; sx <= ref.w - t.bbox.bx1 - 1; sx++) {
          if (
            unexplainedIn(
              Math.max(0, sx),
              Math.max(0, sy),
              Math.min(ref.w, sx + t.w),
              Math.min(ref.h, sy + t.h),
            ) < need
          )
            continue;
          const s = scoreAt(t, sx, sy, ref, explained, minFreshFrac, minExact);
          if (s) candidates.push({ t, sx, sy, ...s });
        }
      }
    }
    candidates.sort(
      (a, b) =>
        a.mis / a.total - b.mis / b.total ||
        b.fresh - a.fresh ||
        (a.sx % CELL === 0 && a.sy % CELL === 0 ? 0 : 1) - (b.sx % CELL === 0 && b.sy % CELL === 0 ? 0 : 1) ||
        a.sy - b.sy ||
        a.sx - b.sx,
    );
    let found = 0;
    for (const c of candidates) {
      const s = scoreAt(c.t, c.sx, c.sy, ref, explained, minFreshFrac, minExact); // re-verify after earlier claims
      if (!s) continue;
      const entry = { id: c.t.id, x: c.sx, y: c.sy, pass, phase: label };
      if (c.t.flipX) entry.flipX = true;
      out.push(entry);
      claim(c.t, c.sx, c.sy, ref, explained);
      found++;
    }
    console.log(`${label} pass ${pass}: ${found} matches (total ${out.length})`);
    if (found === 0) break;
  }
}

async function main() {
  const [refPath, outPath, recompositePath] = process.argv.slice(2);
  if (!refPath || !outPath) {
    console.error("usage: decompose-office-reference.cjs <ref.png> <out.json> [recomposite.png]");
    process.exit(1);
  }
  const ref = await loadRaw(refPath);
  const sprites = await loadSprites();
  const oldComps = await loadComponents(OLD_INTERIORS, "old");
  const miComps = await loadComponents(MI_INTERIORS, "mi");
  const tiles = await loadTiles();
  console.log(
    `ref ${ref.w}x${ref.h}, ${sprites.length} unique sprites, ${oldComps.length} old + ${miComps.length} mi components, ${tiles.length} unique tiles`,
  );

  const explained = new Uint8Array(ref.w * ref.h);
  const objects = [];
  const structure = [];

  runPasses("objects", sprites, ref, explained, objects, OBJ_MIN_FRESH_FRAC, 12);
  // previous-version + Modern Interiors props the office singles don't contain
  runPasses("old-objects", oldComps.concat(miComps), ref, explained, objects, OBJ_MIN_FRESH_FRAC, 6);
  runPasses("tiles", tiles, ref, explained, structure, TILE_MIN_FRESH_FRAC, 12);
  // objects again: pieces that only became matchable once structure was known
  runPasses("objects2", sprites.concat(oldComps, miComps), ref, explained, objects, OBJ_MIN_FRESH_FRAC, 4);
  // Substitute passes: the design was drawn with art revisions that no longer
  // ship in any pack, so what's left gets its CLOSEST real asset (loose
  // exactness, sprite silhouette must still fit). Layout stays exact; pixels
  // may differ slightly from the showcase gif where the artist revised art.
  runPasses("substitute-objects", sprites.concat(oldComps, miComps), ref, explained, objects, 0.3, 4, 0.55);
  // big decor whose art was revised heavily (old whiteboards/chart boards):
  // mostly-fresh regions only, so a wrong sprite can't glue onto matched art
  runPasses("substitute-decor", sprites, ref, explained, objects, 0.5, 2, 0.4);
  runPasses("substitute-tiles", tiles, ref, explained, structure, TILE_MIN_FRESH_FRAC, 4, 0.55);

  let unexplained = 0;
  const clusters = new Map();
  for (let y = 0; y < ref.h; y++) {
    for (let x = 0; x < ref.w; x++) {
      const idx = y * ref.w + x;
      if (explained[idx] || ref.data[idx * 4 + 3] === 0) continue;
      unexplained++;
      const ck = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
      clusters.set(ck, (clusters.get(ck) ?? 0) + 1);
    }
  }
  console.log(`unexplained opaque pixels: ${unexplained}`);
  if (unexplained > 0) {
    const top = [...clusters.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 24);
    console.log("worst cells (col,row 16px):", top.map(([k, n]) => `${k}=${n}`).join(" "));
  }

  fs.writeFileSync(outPath, JSON.stringify({ cell: CELL, objects, tiles: structure, unexplained }, null, 1));
  console.log(`wrote ${outPath}: ${objects.length} objects, ${structure.length} tiles`);

  if (recompositePath) {
    const out = Buffer.alloc(ref.w * ref.h * 4);
    const put = (dx, dy, r, g, b, a) => {
      if (dx < 0 || dy < 0 || dx >= ref.w || dy >= ref.h || a === 0) return;
      const o = (dy * ref.w + dx) * 4;
      const na = a / 255;
      out[o] = Math.round(r * na + out[o] * (1 - na));
      out[o + 1] = Math.round(g * na + out[o + 1] * (1 - na));
      out[o + 2] = Math.round(b * na + out[o + 2] * (1 - na));
      out[o + 3] = Math.max(out[o + 3], a);
    };
    const templateById = new Map();
    for (const s of sprites) if (!s.flipX) templateById.set(s.id, s);
    for (const s of oldComps) if (!s.flipX) templateById.set(s.id, s);
    for (const s of miComps) if (!s.flipX) templateById.set(s.id, s);
    for (const t of tiles) if (!t.flipX) templateById.set(t.id, t);
    const flipCache = new Map();
    const imageFor = (m) => {
      const base = templateById.get(m.id);
      if (!m.flipX) return base;
      if (!flipCache.has(m.id)) flipCache.set(m.id, flipXRaw(base));
      return flipCache.get(m.id);
    };
    const drawAll = (list) => {
      for (const m of [...list].toSorted((a, b) => b.pass - a.pass)) {
        const img = imageFor(m);
        for (let y = 0; y < img.h; y++) {
          for (let x = 0; x < img.w; x++) {
            const o = (y * img.w + x) * 4;
            put(m.x + x, m.y + y, img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]);
          }
        }
      }
    };
    drawAll(structure);
    drawAll(objects);
    await sharp(out, { raw: { width: ref.w, height: ref.h, channels: 4 } }).png().toFile(recompositePath);
    let diff = 0;
    for (let i = 0; i < ref.w * ref.h; i++) {
      const o = i * 4;
      if (ref.data[o + 3] === 0 && out[o + 3] === 0) continue;
      if (
        ref.data[o] !== out[o] ||
        ref.data[o + 1] !== out[o + 1] ||
        ref.data[o + 2] !== out[o + 2] ||
        ref.data[o + 3] !== out[o + 3]
      )
        diff++;
    }
    console.log(`recomposite diff vs reference: ${diff} pixels -> ${recompositePath}`);
  }
}

void main();
