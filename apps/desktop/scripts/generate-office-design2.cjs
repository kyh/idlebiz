// Build office-design.json + its generated assets from the Office_Design_2
// decomposition (scripts/decompose-office-reference.cjs output).
//
// Everything is emitted at 2x (game scale, 32px tiles) using ONLY shipped pack
// art: catalog singles keep their office-object-NNN ids; structure tiles and
// previous-version components become path-objects backed by PNGs sliced from
// the packs' official 32px sheets into public/workspace-kit/design2/. The
// showcase gif was drawn with since-revised sprites, so a small pixel residual
// vs the gif is expected (reported, not patched) — the layout stays exact.
//
// THE SHIPPED office-design.json IS NOW HAND-AUTHORED (via the in-app builder,
// #/office-builder). This script is the head of the pipeline that seeded it —
//   generate -> remove-office-people -> relax-office-anchors -> prune-invisible-office-objects
// — and rerunning it rebuilds from the reference, discarding every hand edit since.
// Kept for provenance and for the render oracles the pipeline shares. Diff before you commit.
//
// Usage: node scripts/generate-office-design2.cjs <decomposed.json> <ref_flat16.png> [out office-design.json]
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");
const { writeLayout, canonicalizeLegacyAnchors } = require("./lib/office-layout-file.cjs");

const VG = "/Users/kyh/Desktop/vg/office";
const PACK = path.join(VG, "Modern_Office_Revamped_v1.2");
const OLD = path.join(PACK, "7_Modern_Office_Previous_Version/Modern_Office_old");
const appRoot = path.resolve(__dirname, "..");
const kit = path.join(appRoot, "public/workspace-kit");
const design2Dir = path.join(kit, "design2");

const SINGLES16 = path.join(PACK, "4_Modern_Office_singles/16x16");
const OLD_INTERIORS16 = path.join(OLD, "Office_interiors_16x16.png");
const TILE_SHEETS16 = {
  rbo: path.join(PACK, "1_Room_Builder_Office/Room_Builder_Office_16x16.png"),
  ow: path.join(OLD, "Office_walls_floors_16x16.png"),
  mirb: path.join(VG, "moderninteriors-win/1_Interiors/16x16/Room_Builder_16x16.png"),
};
const TILE_SHEETS32 = {
  rbo: path.join(PACK, "1_Room_Builder_Office/Room_Builder_Office_32x32.png"),
  ow: path.join(OLD, "Upscaled_versions/Office_walls_floors_32x32.png"),
  mirb: path.join(VG, "moderninteriors-win/1_Interiors/32x32/Room_Builder_32x32.png"),
};
const OLD_INTERIORS32 = path.join(OLD, "Upscaled_versions/Office_interiors_32x32.png");
const MI_INTERIORS16 = path.join(VG, "moderninteriors-win/1_Interiors/16x16/Interiors_16x16.png");
const MI_INTERIORS32 = path.join(VG, "moderninteriors-win/1_Interiors/32x32/Interiors_32x32.png");

const CELL16 = 16; // decomposition cell at source scale
const W16 = 256;
const H16 = 272; // content height at source scale (drop the blank canvas tail)

const { loadRaw, opaqueBounds } = require("./lib/pixels.cjs");

function nearest2x(img) {
  const out = Buffer.alloc(img.w * 2 * img.h * 2 * 4);
  for (let y = 0; y < img.h * 2; y++) {
    for (let x = 0; x < img.w * 2; x++) {
      const so = ((y >> 1) * img.w + (x >> 1)) * 4;
      const po = (y * img.w * 2 + x) * 4;
      img.data.copy(out, po, so, so + 4);
    }
  }
  return { data: out, w: img.w * 2, h: img.h * 2 };
}

async function writePng(img, file) {
  await sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } })
    .png()
    .toFile(file);
}

function crop(img, x, y, w, h) {
  const data = Buffer.alloc(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    img.data.copy(data, yy * w * 4, ((y + yy) * img.w + x) * 4, ((y + yy) * img.w + x + w) * 4);
  }
  return { data, w, h };
}

// old components carry their bbox in the id origin; recover extents by
// reflooding the sheet from that origin (same 8-connectivity as decompose).
function floodComponent(img, ox, oy) {
  // find the component whose bbox min corner is (ox,oy)
  const seen = new Uint8Array(img.w * img.h);
  // scan the neighborhood: the origin pixel itself may be transparent (bbox
  // corner), so flood from every opaque pixel in the bbox-ish area until the
  // component with min corner (ox,oy) is found.
  for (let y0 = oy; y0 < Math.min(img.h, oy + 48); y0++) {
    for (let x0 = ox; x0 < Math.min(img.w, ox + 64); x0++) {
      const idx0 = y0 * img.w + x0;
      if (seen[idx0] || img.data[idx0 * 4 + 3] === 0) continue;
      const stack = [idx0];
      seen[idx0] = 1;
      const px = [];
      let minX = x0,
        maxX = x0,
        minY = y0,
        maxY = y0;
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
      if (minX === ox && minY === oy) {
        const w = maxX - minX + 1;
        const h = maxY - minY + 1;
        const data = Buffer.alloc(w * h * 4);
        for (const idx of px) {
          const x = idx % img.w;
          const y = (idx / img.w) | 0;
          img.data.copy(data, ((y - minY) * w + (x - minX)) * 4, idx * 4, idx * 4 + 4);
        }
        return { data, w, h, srcX: minX, srcY: minY };
      }
    }
  }
  throw new Error(`component at ${ox},${oy} not found`);
}

const touches = (a, b) =>
  a.x0 <= b.x1 + 2 && b.x0 <= a.x1 + 2 && a.y0 <= b.y1 + 2 && b.y0 <= a.y1 + 2;

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
  return { ...img, data };
}

async function main() {
  const [decomposedPath, refPath, outPathArg] = process.argv.slice(2);
  if (!decomposedPath || !refPath) {
    console.error(
      "usage: generate-office-design2.cjs <decomposed.json> <ref_flat16.png> [out.json]",
    );
    process.exit(1);
  }
  const outPath = outPathArg
    ? path.resolve(outPathArg)
    : path.join(appRoot, "src/renderer/game/office-design.json");
  const dec = JSON.parse(fs.readFileSync(decomposedPath, "utf8"));
  const ref16 = await loadRaw(refPath);
  const ref2x = nearest2x(ref16);

  fs.mkdirSync(design2Dir, { recursive: true });

  // ---------- load template images (16px, for masks + z bookkeeping) ----------
  const sheets16 = {};
  for (const [k, f] of Object.entries(TILE_SHEETS16)) sheets16[k] = await loadRaw(f);
  const sheets32 = {};
  for (const [k, f] of Object.entries(TILE_SHEETS32)) {
    sheets32[k] = await loadRaw(f);
    if (sheets32[k].w !== sheets16[k].w * 2 || sheets32[k].h !== sheets16[k].h * 2) {
      throw new Error(`sheet ${k}: 32px sheet is not 2x the 16px sheet`);
    }
  }
  const oldInteriors16 = await loadRaw(OLD_INTERIORS16);
  const oldInteriors32 = await loadRaw(OLD_INTERIORS32);
  const miInteriors16 = await loadRaw(MI_INTERIORS16);
  const miInteriors32 = await loadRaw(MI_INTERIORS32);

  const templateCache = new Map();
  async function template16(id) {
    if (templateCache.has(id)) return templateCache.get(id);
    let img;
    let m;
    if ((m = /^obj-(\d+)$/.exec(id))) {
      img = await loadRaw(path.join(SINGLES16, `Modern_Office_Singles_${m[1]}.png`));
    } else if ((m = /^old-(\d+)-(\d+)$/.exec(id))) {
      // component bbox is discovered lazily from the sheet at its recorded origin
      throw new Error(`old component ${id} needs srcRect metadata`);
    } else if ((m = /^(rbo|ow|mirb)-(\d+)-(\d+)$/.exec(id))) {
      const sheet = sheets16[m[1]];
      img = crop(sheet, Number(m[2]) * CELL16, Number(m[3]) * CELL16, CELL16, CELL16);
    } else if ((m = /^(mo\d+)-(\d+)-(\d+)$/.exec(id)) && dec.tileSourceFiles?.[m[1]]) {
      const sheet = await loadRaw(dec.tileSourceFiles[m[1]]);
      img = crop(sheet, Number(m[2]) * CELL16, Number(m[3]) * CELL16, CELL16, CELL16);
    } else {
      throw new Error(`unknown template id: ${id}`);
    }
    templateCache.set(id, img);
    return img;
  }

  async function templateFor(id) {
    if (templateCache.has(id)) return templateCache.get(id);
    let m;
    if ((m = /^old-(\d+)-(\d+)$/.exec(id))) {
      const comp = floodComponent(oldInteriors16, Number(m[1]), Number(m[2]));
      templateCache.set(id, comp);
      return comp;
    }
    if ((m = /^mi-(\d+)-(\d+)$/.exec(id))) {
      const comp = floodComponent(miInteriors16, Number(m[1]), Number(m[2]));
      templateCache.set(id, comp);
      return comp;
    }
    if ((m = /^(an\d+)-(\d+)-(\d+)$/.exec(id)) && dec.compSourceFiles?.[m[1]]) {
      const sheet = await loadRaw(dec.compSourceFiles[m[1]]);
      const comp = floodComponent(sheet, Number(m[2]), Number(m[3]));
      templateCache.set(id, comp);
      return comp;
    }
    return template16(id);
  }
  /** Template image for a decomposed entry, honoring its flipX. */
  async function templateForEntry(entry) {
    if (!entry.flipX) return templateFor(entry.id);
    const key = `${entry.id}|flip`;
    if (templateCache.has(key)) return templateCache.get(key);
    const flipped = flipXRaw(await templateFor(entry.id));
    templateCache.set(key, flipped);
    return flipped;
  }

  // ---------- rebuild z-ordered draw list (matches decompose recomposite) ----------
  // clearRects (source px): hand-curated zones where the gif used art that no
  // pack ships anymore — matched fragments there read as junk, so objects and
  // substitute tiles inside are dropped and manualPlacements provide a clean
  // native furnishing instead (drawn topmost).
  const CLEAR = loadClassification0();
  const inClearRect = async (entry) => {
    if (!CLEAR.clearRects.length) return false;
    const img = await templateForEntry(entry);
    const b = opaqueBounds(img);
    const cx = entry.x + b.x + b.w / 2;
    const cy = entry.y + b.y + b.h / 2;
    return CLEAR.clearRects.some(([x0, y0, x1, y1]) => cx >= x0 && cx < x1 && cy >= y0 && cy < y1);
  };
  const drawList = [];
  for (const t of dec.tiles.toSorted((a, b) => b.pass - a.pass)) {
    if ((t.phase ?? "").startsWith("substitute") && (await inClearRect(t))) continue;
    drawList.push({ ...t, kind: "tile" });
  }
  const decObjects = dec.objects.concat(
    CLEAR.manualPlacements.map((m) => Object.assign({ pass: 0, phase: "manual" }, m)),
  );
  for (const o of decObjects.toSorted((a, b) => b.pass - a.pass)) {
    if (o.phase !== "manual" && (await inClearRect(o))) continue;
    drawList.push({ ...o, kind: "object" });
  }

  // coverage stack: topmost template covering each pixel (16px scale)
  const owner = new Int32Array(W16 * H16);
  async function computeOwner() {
    owner.fill(-1);
    for (let i = 0; i < drawList.length; i++) {
      const entry = drawList[i];
      const img = await templateForEntry(entry);
      for (let y = 0; y < img.h; y++) {
        for (let x = 0; x < img.w; x++) {
          if (img.data[(y * img.w + x) * 4 + 3] === 0) continue;
          const gx = entry.x + x;
          const gy = entry.y + y;
          if (gx < 0 || gy < 0 || gx >= W16 || gy >= H16) continue;
          owner[gy * W16 + gx] = i; // later draw = higher z wins
        }
      }
    }
  }
  await computeOwner();

  // Buried fragments: a matched piece that is almost entirely covered in the
  // reference contributes a sliver of pixels but a whole sprite of y-sort
  // headaches. Drop pieces <12% visible; their slivers become correction
  // decals via the residual pass instead.
  {
    const visible = new Map();
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] >= 0) visible.set(owner[i], (visible.get(owner[i]) ?? 0) + 1);
    }
    const keep = [];
    let dropped = 0;
    for (let i = 0; i < drawList.length; i++) {
      const entry = drawList[i];
      if (entry.kind === "object") {
        const img = await templateForEntry(entry);
        let opaque = 0;
        for (let k = 3; k < img.data.length; k += 4) if (img.data[k] === 255) opaque++;
        const vis = visible.get(i) ?? 0;
        if (vis / opaque < 0.12) {
          dropped++;
          continue;
        }
      }
      keep.push(entry);
    }
    if (dropped) {
      drawList.length = 0;
      drawList.push(...keep);
      await computeOwner();
      console.log(`dropped ${dropped} buried fragments (<12% visible)`);
    }
  }

  // residual: reference pixels the recomposite gets wrong (drift or unmatched)
  const residualOwner = new Map(); // drawList index -> [pixel indices]
  const orphan = [];
  {
    // recomposite at 16px
    const rec = Buffer.alloc(W16 * H16 * 4);
    for (const entry of drawList) {
      const img = await templateForEntry(entry);
      for (let y = 0; y < img.h; y++) {
        for (let x = 0; x < img.w; x++) {
          const so = (y * img.w + x) * 4;
          const a = img.data[so + 3];
          if (a === 0) continue;
          const gx = entry.x + x;
          const gy = entry.y + y;
          if (gx < 0 || gy < 0 || gx >= W16 || gy >= H16) continue;
          const po = (gy * W16 + gx) * 4;
          const na = a / 255;
          rec[po] = Math.round(img.data[so] * na + rec[po] * (1 - na));
          rec[po + 1] = Math.round(img.data[so + 1] * na + rec[po + 1] * (1 - na));
          rec[po + 2] = Math.round(img.data[so + 2] * na + rec[po + 2] * (1 - na));
          rec[po + 3] = Math.max(rec[po + 3], a);
        }
      }
    }
    for (let y = 0; y < H16; y++) {
      for (let x = 0; x < W16; x++) {
        const idx = y * W16 + x;
        const ro = idx * 4;
        const refOpaque = ref16.data[(y * ref16.w + x) * 4 + 3] !== 0;
        const refO = (y * ref16.w + x) * 4;
        const same =
          ref16.data[refO] === rec[ro] &&
          ref16.data[refO + 1] === rec[ro + 1] &&
          ref16.data[refO + 2] === rec[ro + 2] &&
          (ref16.data[refO + 3] === 255) === (rec[ro + 3] === 255);
        if (same || !refOpaque) continue;
        const own = owner[idx];
        if (own >= 0) {
          if (!residualOwner.has(own)) residualOwner.set(own, []);
          residualOwner.get(own).push(idx);
        } else {
          orphan.push(idx);
        }
      }
    }
  }
  console.log(
    `residual: ${[...residualOwner.values()].reduce((n, v) => n + v.length, 0)} owned px across ${residualOwner.size} templates, ${orphan.length} orphan px`,
  );

  // ---------- emit assets + layout objects ----------
  const CLASS = loadClassification();
  const objects = [];
  const writtenAssets = new Map(); // asset id -> path

  async function emitAsset(id, img2x) {
    if (writtenAssets.has(id)) return writtenAssets.get(id);
    const rel = `workspace-kit/design2/${id}.png`;
    await writePng(img2x, path.join(kit, "design2", `${id}.png`));
    writtenAssets.set(id, rel);
    return rel;
  }

  // The showcase was drawn with sprite revisions that ship in no sheet; the
  // aseprite design file IS part of the pack, so the last ~2% of pixels come
  // from it as tiny correction decals layered over the real-asset placements.
  let fixSeq = 0;
  function cutPixels(pixelIdxs) {
    let minX = W16,
      minY = H16,
      maxX = -1,
      maxY = -1;
    for (const idx of pixelIdxs) {
      const x = idx % W16;
      const y = (idx / W16) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const w = (maxX - minX + 1) * 2;
    const h = (maxY - minY + 1) * 2;
    const data = Buffer.alloc(w * h * 4);
    for (const idx of pixelIdxs) {
      const gx = idx % W16;
      const gy = (idx / W16) | 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const srcO = ((gy * 2 + sy) * ref2x.w + gx * 2 + sx) * 4;
          const dstO = (((gy - minY) * 2 + sy) * w + (gx - minX) * 2 + sx) * 4;
          ref2x.data.copy(data, dstO, srcO, srcO + 4);
        }
      }
    }
    return { data, w, h, offX: minX * 2, offY: minY * 2 };
  }
  async function fixPlacementFor(pixelIdxs, like) {
    const cut = cutPixels(pixelIdxs);
    const rel = await emitAsset(`d2-fix-${fixSeq++}`, cut);
    return {
      id: rel.replace("workspace-kit/design2/", "").replace(".png", ""),
      x: cut.offX,
      y: cut.offY,
      layer: like.layer,
      anchorY: like.anchorY,
      path: rel,
    };
  }

  // Structure tiles in draw order. Plain structure is floor-layer anchorY 0
  // (stable sort preserves the recovered stacking); tiles inside a wall band
  // become object-layer at the band's floor line so a character standing
  // NORTH of the wall (e.g. the strip above the divider) is occluded by it.
  const bandFor = (cx, cy) =>
    CLASS.wallBands.find(([x0, y0, x1, y1]) => cx >= x0 && cx < x1 && cy >= y0 && cy < y1) ?? null;

  // Hole filling: reference-opaque pixels no placement covers (art that was
  // revised out of the packs, e.g. behind the old wall TV) get their cell
  // filled with the nearest same-row structure tile, drawn under everything.
  {
    const fillCells = new Set();
    for (let y = 0; y < H16; y++) {
      for (let x = 0; x < W16; x++) {
        const idx = y * W16 + x;
        if (owner[idx] >= 0) continue;
        if (ref16.data[(y * ref16.w + x) * 4 + 3] !== 255) continue;
        fillCells.add(`${x & ~15},${y & ~15}`);
      }
    }
    const tileEntries = drawList.filter((e) => e.kind === "tile");
    let fills = 0;
    for (const key of fillCells) {
      const [cx, cy] = key.split(",").map(Number);
      // donor = an explicit per-zone override, else the most common tile in
      // the local row band (a lone dark trim neighbor must not win over the
      // dominant wall/floor fill)
      const donorOverride = CLEAR.fillDonors.find(
        (f) =>
          cx + 8 >= f.rect[0] && cx + 8 < f.rect[2] && cy + 8 >= f.rect[1] && cy + 8 < f.rect[3],
      );
      let best = donorOverride ? { t: { id: donorOverride.tile }, n: 1 } : null;
      if (!best) {
        const counts = new Map();
        for (const t of tileEntries) {
          if (Math.abs(t.y - cy) > 16 || Math.abs(t.x - cx) > 56) continue;
          counts.set(t.id, (counts.get(t.id) ?? 0) + 1);
        }
        for (const [id, n] of counts) {
          if (!best || n > best.n) best = { t: { id }, n };
        }
      }
      if (!best) continue;
      const img2x = await (async () => {
        const m = /^(rbo|ow|mirb)-(\d+)-(\d+)$/.exec(best.t.id);
        return m
          ? crop(sheets32[m[1]], Number(m[2]) * 32, Number(m[3]) * 32, 32, 32)
          : nearest2x(await templateFor(best.t.id));
      })();
      const assetId = `d2-${best.t.id}`;
      const rel = await emitAsset(assetId, img2x);
      const band = bandFor(cx * 2 + 16, cy * 2 + 16);
      objects.push({
        id: assetId,
        x: cx * 2,
        y: cy * 2,
        layer: band ? "object" : "floor",
        anchorY: band ? band[4] : 0,
        path: rel,
      });
      fills++;
    }
    console.log(`hole fill: ${fills} cells (from ${fillCells.size} candidates)`);
  }

  for (let i = 0; i < drawList.length; i++) {
    const entry = drawList[i];
    if (entry.kind !== "tile") continue;
    const m = /^(rbo|ow|mirb)-(\d+)-(\d+)$/.exec(entry.id);
    const img2x = m
      ? crop(sheets32[m[1]], Number(m[2]) * 32, Number(m[3]) * 32, 32, 32)
      : nearest2x(await templateFor(entry.id));
    const assetId = `d2-${entry.id}`;
    const rel = await emitAsset(assetId, img2x);
    const band = bandFor(entry.x * 2 + 16, entry.y * 2 + 16);
    const placement = {
      id: assetId,
      x: entry.x * 2,
      y: entry.y * 2,
      layer: band ? "object" : "floor",
      anchorY: band ? band[4] : 0,
      path: rel,
    };
    if (entry.flipX) placement.flipX = true;
    objects.push(placement);
    const fixPx = residualOwner.get(i);
    if (fixPx?.length) objects.push(await fixPlacementFor(fixPx, placement));
  }

  console.log(`emitted ${objects.length} structure entries (assets: ${writtenAssets.size})`);

  await emitObjects();
  await resolveLayers();
  // corrections ride directly after their owner (same layer/anchor; the stable
  // tie-break draws them on top of it and nothing else)
  {
    let fixes = 0;
    for (let pos = objects.length - 1; pos >= 0; pos--) {
      const o = objects[pos];
      if (!o.meta) continue;
      const fixPx = residualOwner.get(o.meta.drawIndex);
      if (!fixPx?.length) continue;
      objects.splice(pos + 1, 0, await fixPlacementFor(fixPx, o));
      fixes++;
    }
    // pixels no placement owns: wall/floor decor the packs never shipped
    const set = new Set(orphan);
    const visited = new Set();
    let orphanDecals = 0;
    for (const idx of orphan) {
      if (visited.has(idx)) continue;
      const stack = [idx];
      visited.add(idx);
      const px = [];
      while (stack.length) {
        const cur = stack.pop();
        px.push(cur);
        const cx = cur % W16;
        const cy = (cur / W16) | 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W16 || ny >= H16) continue;
            const nidx = ny * W16 + nx;
            if (!set.has(nidx) || visited.has(nidx)) continue;
            visited.add(nidx);
            stack.push(nidx);
          }
        }
      }
      let maxY = 0;
      let onFurniture = null;
      for (const p of px) {
        const y = (p / W16) | 0;
        if (y > maxY) maxY = y;
        const own = owner[p - 1] >= 0 ? owner[p - 1] : owner[p + 1];
        if (own >= 0 && drawList[own].kind === "object" && !onFurniture) {
          onFurniture = objects.find((o) => o.meta && o.meta.drawIndex === own) ?? null;
        }
      }
      const like = onFurniture
        ? { layer: onFurniture.layer, anchorY: onFurniture.anchorY } // rides its support
        : { layer: "floor", anchorY: 10_000 + (maxY + 1) * 2 };
      objects.push(await fixPlacementFor(px, like));
      orphanDecals++;
    }
    console.log(
      `corrections: ${fixes} drift decals + ${orphanDecals} orphan decals (cut from the pack's design file)`,
    );
  }
  console.log(`orphan px left to nearest-asset substitution: ${orphan.length}`);
  const layout = await finalize();

  // ---- closing pass: whatever the composed render still gets wrong (band
  // ordering ties etc.) is baked as reference decals in the right band ----
  for (let round = 1; round <= 4; round++) {
    const tmpLayout = "/tmp/design2-closing.json";
    const tmpRender = "/tmp/design2-closing.png";
    fs.writeFileSync(tmpLayout, JSON.stringify(layout));
    execFileSync("node", [
      path.join(__dirname, "render-office-preview.cjs"),
      "--layout",
      tmpLayout,
      tmpRender,
    ]);
    const rendered = await loadRaw(tmpRender);
    const bad = [];
    for (let y = 0; y < 544; y++) {
      for (let x = 0; x < 512; x++) {
        const ro = (y * ref2x.w + x) * 4;
        if (ref2x.data[ro + 3] !== 255) continue;
        const co = (y * rendered.w + x) * 4;
        if (
          ref2x.data[ro] !== rendered.data[co] ||
          ref2x.data[ro + 1] !== rendered.data[co + 1] ||
          ref2x.data[ro + 2] !== rendered.data[co + 2]
        )
          bad.push(y * 512 + x);
      }
    }
    // cluster (2x space, 3px slack), cut from ref2x, band-aware placement
    const set = new Set(bad);
    const visited = new Set();
    let closing = 0;
    const roundTag = `r${round}`;
    for (const start of bad) {
      if (visited.has(start)) continue;
      const stack = [start];
      visited.add(start);
      const px = [];
      let minX = 512,
        minY = 544,
        maxX = -1,
        maxY = -1;
      while (stack.length) {
        const cur = stack.pop();
        px.push(cur);
        const cx = cur % 512;
        const cy = (cur / 512) | 0;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= 512 || ny >= 544) continue;
            const nidx = ny * 512 + nx;
            if (!set.has(nidx) || visited.has(nidx)) continue;
            visited.add(nidx);
            stack.push(nidx);
          }
        }
      }
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      const data = Buffer.alloc(w * h * 4);
      for (const cur of px) {
        const cx = cur % 512;
        const cy = (cur / 512) | 0;
        const srcO = (cy * ref2x.w + cx) * 4;
        ref2x.data.copy(data, ((cy - minY) * w + (cx - minX)) * 4, srcO, srcO + 4);
      }
      const assetId = `d2-close-${roundTag}-${closing++}`;
      const rel = await emitAsset(assetId, { data, w, h });
      const band = bandFor(minX + w / 2, maxY);
      // pixels that survive a round are being overdrawn by overhead pieces —
      // escalate later rounds above the overhead band (static scenery truth)
      layout.objects.push(
        round >= 2
          ? {
              id: assetId,
              x: minX,
              y: minY,
              layer: "overhead",
              anchorY: 900_000 + round,
              path: rel,
            }
          : band
            ? { id: assetId, x: minX, y: minY, layer: "object", anchorY: band[4], path: rel }
            : {
                id: assetId,
                x: minX,
                y: minY,
                layer: "floor",
                anchorY: 10_000 + maxY + 1,
                path: rel,
              },
      );
    }
    console.log(`closing pass ${round}: ${bad.length} px -> ${closing} decals`);
    if (bad.length === 0) break;
  }

  // spend the working anchors: the shipped model orders the flat bands by the
  // array, not by a sort key (see lib/office-layout-file.cjs)
  layout.objects = canonicalizeLegacyAnchors(layout.objects);
  writeLayout(layout, outPath);
  console.log(`wrote ${outPath}: ${layout.objects.length} objects`);

  // ---------- second half ----------
  async function emitObjects() {
    for (let i = 0; i < drawList.length; i++) {
      const entry = drawList[i];
      if (entry.kind !== "object") continue;
      const img16 = await templateForEntry(entry);
      const b16 = opaqueBounds(img16);
      const anchorY = (entry.y + b16.y + b16.h) * 2;
      const catalog = /^obj-(\d+)$/.exec(entry.id);
      let placement;
      if (catalog && CLASS.floorPatchObjects.has(entry.id)) {
        // flat floor-texture pieces (obj-92 family): they patch plain floor,
        // so they must render UNDER actors — as objects their big anchors hid
        // character bodies. Above structure tiles, below everything else.
        placement = {
          id: `office-object-${catalog[1].padStart(3, "0")}`,
          x: entry.x * 2,
          y: entry.y * 2,
          layer: "floor",
          anchorY: 10_000 + anchorY,
        };
      } else if (catalog) {
        placement = {
          id: `office-object-${catalog[1].padStart(3, "0")}`,
          x: entry.x * 2,
          y: entry.y * 2,
          layer: "object",
          anchorY,
        };
      } else {
        // previous-version / Modern Interiors / animated-object component:
        // sliced from the official 32px sheet, or scaled 2x for era art
        const comp = await templateFor(entry.id);
        let img2x;
        if (entry.id.startsWith("mi-")) {
          img2x = crop(miInteriors32, comp.srcX * 2, comp.srcY * 2, comp.w * 2, comp.h * 2);
        } else if (entry.id.startsWith("old-")) {
          img2x = crop(oldInteriors32, comp.srcX * 2, comp.srcY * 2, comp.w * 2, comp.h * 2);
        } else {
          img2x = nearest2x(comp);
        }
        const assetId = `d2-${entry.id}`;
        const rel = await emitAsset(assetId, img2x);
        placement = {
          id: assetId,
          x: entry.x * 2,
          y: entry.y * 2,
          layer: "object",
          anchorY,
          path: rel,
        };
      }
      if (entry.flipX) placement.flipX = true;
      placement.meta = {
        drawIndex: i,
        templateId: entry.id,
        ex: entry.x,
        ey: entry.y,
        flipX: entry.flipX === true,
      };
      objects.push(placement);
    }
    console.log(`after objects: ${objects.length} entries, ${writtenAssets.size} assets`);
  }

  // Layering, kept simple — three bands like the source art:
  //   floor:    flat structure tiles + floor-texture patches (under everyone)
  //   object:   furniture that touches the ground, y-sorted by content bottom
  //   overhead: props that sit ON furniture — always above walkers, which is
  //             also correct (a walker overlapping a desktop stands behind it)
  // Wall-mounted decor snaps to its wall band's floor line and draws after the
  // band tiles (stable tie-break), so walkers in front still cover it.
  async function resolveLayers() {
    const objPlacements = objects.filter((o) => o.meta && o.layer === "object");
    objPlacements.sort((a, b) => a.meta.drawIndex - b.meta.drawIndex);
    const masks = new Map();
    for (const o of objPlacements) {
      const img = await templateForEntry({ id: o.meta.templateId, flipX: o.meta.flipX });
      masks.set(o, { img, x: o.meta.ex, y: o.meta.ey });
    }
    const overlaps = (a, b) => {
      const A = masks.get(a);
      const B = masks.get(b);
      const x0 = Math.max(A.x, B.x);
      const y0 = Math.max(A.y, B.y);
      const x1 = Math.min(A.x + A.img.w, B.x + B.img.w);
      const y1 = Math.min(A.y + A.img.h, B.y + B.img.h);
      if (x1 <= x0 || y1 <= y0) return false;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const ao = ((y - A.y) * A.img.w + (x - A.x)) * 4 + 3;
          const bo = ((y - B.y) * B.img.w + (x - B.x)) * 4 + 3;
          if (A.img.data[ao] > 0 && B.img.data[bo] > 0) return true;
        }
      }
      return false;
    };
    // A piece drawn above a support it would y-sort below snaps to the
    // support's anchor: stable insertion (z order) draws it above the support,
    // while a walker standing south of both still covers them — no overhead
    // band, so heads never get clipped by desk props. Iterate to fixpoint so
    // stacks (paper on monitor on desk) chain up.
    let snapped = 0;
    for (let round = 0; round < 6; round++) {
      let changed = false;
      for (let j = 1; j < objPlacements.length; j++) {
        for (let i = 0; i < j; i++) {
          if (objPlacements[j].anchorY >= objPlacements[i].anchorY) continue;
          if (!overlaps(objPlacements[i], objPlacements[j])) continue;
          objPlacements[j].anchorY = objPlacements[i].anchorY;
          snapped++;
          changed = true;
        }
      }
      if (!changed) break;
    }
    // pass 3: wall-mounted decor rides its band's floor line
    let banded = 0;
    for (const o of objPlacements) {
      if (o.layer !== "object") continue;
      const band = bandFor(o.x + 16, o.anchorY - 8);
      if (band && o.anchorY <= band[4]) {
        o.anchorY = band[4];
        banded++;
      }
    }
    console.log(`layers: ${snapped} support snaps, ${banded} snapped to wall bands`);
  }

  async function finalize() {
    // collision + seats come from the classification table
    const cols = 32;
    const rows = 34;
    const solid = Array.from({ length: rows }, () => Array(cols).fill(true));
    // Carve walkable space by grounding on the reference pixels themselves:
    // build the three floor-fill palettes from known-pure floor patches, then
    // a cell is floor when most of its pixels belong to one palette. (Tile-id
    // classification is hopeless — the packs reuse flat fills across walls
    // and floors.)
    {
      const paletteRects = [
        // gray office floor (open band above row-1 cubicles + main aisle)
        [48, 66, 400, 92],
        [32, 170, 480, 196],
        // break room plank floor
        [232, 416, 296, 470],
        [128, 436, 160, 470],
        // manager office wood floor
        [360, 470, 480, 494],
        [426, 384, 470, 420],
      ];
      const counts = new Map();
      for (const [x0, y0, x1, y1] of paletteRects) {
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const o = (y * ref2x.w + x) * 4;
            const key = (ref2x.data[o] << 16) | (ref2x.data[o + 1] << 8) | ref2x.data[o + 2];
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
      }
      const palette = new Set([...counts.entries()].filter(([, n]) => n >= 40).map(([k]) => k));
      console.log(`floor palette: ${palette.size} colors`);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let hit = 0;
          for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 16; x++) {
              const gx = c * 16 + x;
              const gy = r * 16 + y;
              if (gx >= 512 || gy >= 544) continue;
              const o = (gy * ref2x.w + gx) * 4;
              if (ref2x.data[o + 3] !== 255) continue;
              const key = (ref2x.data[o] << 16) | (ref2x.data[o + 1] << 8) | ref2x.data[o + 2];
              if (palette.has(key)) hit++;
            }
          }
          if (hit >= 256 * 0.35) solid[r][c] = false;
        }
      }
    }
    // hand-authored geometry patches (game px rects). Walkable rects cover
    // every touched cell; solid rects only cells whose CENTER they cover, so
    // a band that grazes a lane row doesn't swallow it.
    const paintRects = (rects, value) => {
      for (const [x0, y0, x1, y1] of rects) {
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const inside = value
              ? c * 16 + 8 >= x0 && c * 16 + 8 < x1 && r * 16 + 8 >= y0 && r * 16 + 8 < y1
              : c * 16 < x1 && c * 16 + 16 > x0 && r * 16 < y1 && r * 16 + 16 > y0;
            if (inside) solid[r][c] = value;
          }
        }
      }
    };
    paintRects(CLASS.walkableRects, false);
    // wall tiles and solid furniture paint back solid
    const bbox2x = async (entry) => {
      const img = await templateFor(entry.id);
      const b = opaqueBounds(img);
      return {
        x0: (entry.x + b.x) * 2,
        y0: (entry.y + b.y) * 2,
        x1: (entry.x + b.x + b.w) * 2,
        y1: (entry.y + b.y + b.h) * 2,
      };
    };
    const paintSolid = ({ x0, y0, x1, y1 }) => {
      for (let r = Math.floor(y0 / 16); r < Math.ceil(y1 / 16); r++) {
        for (let c = Math.floor(x0 / 16); c < Math.ceil(x1 / 16); c++) {
          if (r >= 0 && c >= 0 && r < rows && c < cols) solid[r][c] = true;
        }
      }
    };
    for (let i = 0; i < drawList.length; i++) {
      const entry = drawList[i];
      const isWallTile = entry.kind === "tile" && CLASS.wallTiles.has(entry.id);
      const isSolidObj = entry.kind === "object" && CLASS.solidObjects.has(entry.id);
      if (!isWallTile && !isSolidObj) continue;
      paintSolid(await bbox2x(entry));
    }

    // desk-surface texture tiles (obj-92 family) also patch plain floor, so
    // they are solid only where connected (transitively) to desk edge pieces.
    {
      const edges = [];
      for (const entry of drawList) {
        if (entry.kind === "object" && CLASS.deskEdges.has(entry.id))
          edges.push(await bbox2x(entry));
      }
      const deskTiles = [];
      for (const entry of drawList) {
        if (entry.kind === "object" && CLASS.deskTiles.has(entry.id)) {
          deskTiles.push({ box: await bbox2x(entry), solid: false });
        }
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const t of deskTiles) {
          if (t.solid) continue;
          if (
            edges.some((e) => touches(t.box, e)) ||
            deskTiles.some((o) => o.solid && touches(t.box, o.box))
          ) {
            t.solid = true;
            changed = true;
          }
        }
      }
      let kept = 0;
      for (const t of deskTiles) {
        if (t.solid) {
          paintSolid(t.box);
          kept++;
        }
      }
      console.log(`desk tiles: ${kept}/${deskTiles.length} solid (edge-connected)`);
    }

    paintRects(CLASS.solidRects, true);
    // hand-authored squeeze-through carves (walker passes behind furniture)
    paintRects(CLASS.carveRects, false);

    // seats carve back walkable (chairs tuck into desk bboxes visually)
    for (const entry of drawList) {
      if (entry.kind !== "object" || !CLASS.seatObjects.has(entry.id)) continue;
      const { x0, y0, x1, y1 } = await bbox2x(entry);
      for (let r = Math.floor(y0 / 16); r < Math.ceil(y1 / 16); r++) {
        for (let c = Math.floor(x0 / 16); c < Math.ceil(x1 / 16); c++) {
          if (r >= 0 && c >= 0 && r < rows && c < cols) solid[r][c] = false;
        }
      }
    }

    const workSeats = [];
    for (const o of objects) {
      if (!o.meta) continue;
      if (CLASS.seatObjects.has(o.meta.templateId)) {
        const img = await templateFor(o.meta.templateId);
        const b = opaqueBounds(img);
        workSeats.push({
          x: Math.round((o.meta.ex + b.x + b.w / 2) * 2),
          y: Math.round((o.meta.ey + b.y + b.h - 4) * 2),
        });
      }
    }

    for (const o of objects) delete o.meta;

    // Reachability with the game's ACTUAL movement model: positions are
    // blocked when any body-box corner (±8, ±6 around the point) is in a
    // solid cell, and pathing nodes sit at 16px cell centers (OfficeScene
    // bodyBlockedAt/makePathProvider). Point-BFS overstates — a 16px-wide
    // corridor cannot fit the 16px body box.
    {
      const solidCell = (c, r) => c < 0 || r < 0 || c >= cols || r >= rows || solid[r][c];
      const bodyBlocked = (x, y) =>
        solidCell(Math.floor((x - 8) / 16), Math.floor((y - 6) / 16)) ||
        solidCell(Math.floor((x + 8) / 16), Math.floor((y - 6) / 16)) ||
        solidCell(Math.floor((x - 8) / 16), Math.floor((y + 6) / 16)) ||
        solidCell(Math.floor((x + 8) / 16), Math.floor((y + 6) / 16));
      const nodeOpen = (gx, gy) => !bodyBlocked(gx * 16 + 8, gy * 16 + 8);
      const seen = Array.from({ length: rows }, () => Array(cols).fill(false));
      const sc = Math.floor(CLASS.spawn.x / 16);
      const sr = Math.floor(CLASS.spawn.y / 16);
      const queue = [];
      if (nodeOpen(sc, sr)) {
        seen[sr][sc] = true;
        queue.push([sc, sr]);
      } else console.warn(`spawn (${CLASS.spawn.x},${CLASS.spawn.y}) is body-blocked`);
      while (queue.length) {
        const [c, r] = queue.shift();
        for (const [dc, dr] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || seen[nr][nc] || !nodeOpen(nc, nr))
            continue;
          seen[nr][nc] = true;
          queue.push([nc, nr]);
        }
      }
      let reach = 0;
      for (const s of workSeats) {
        const c = Math.floor(s.x / 16);
        const r = Math.floor(s.y / 16);
        let ok = false;
        for (let dr = -3; dr <= 3 && !ok; dr++) {
          for (let dc = -3; dc <= 3; dc++) {
            if (seen[r + dr]?.[c + dc]) {
              ok = true;
              break;
            }
          }
        }
        if (ok) reach++;
        else console.warn(`seat (${s.x},${s.y}) cell(${c},${r}) UNREACHABLE (body-aware)`);
      }
      const nodes = seen.flat().filter(Boolean).length;
      console.log(
        `body-aware reachability: ${reach}/${workSeats.length} seats, ${nodes} reachable nodes from spawn`,
      );
      console.log(
        solid
          .map((row, r) => row.map((v, c) => (v ? "#" : seen[r][c] ? "O" : ".")).join(""))
          .join("\n"),
      );
    }

    return {
      tile: 32,
      width: 512,
      height: 544,
      cell: 16,
      cols,
      rows,
      spawn: CLASS.spawn,
      objects,
      collision: solid.map((row) => row.map((v) => (v ? "1" : "0")).join("")),
      workSeats,
    };
  }

  function loadClassification0() {
    const p = path.join(__dirname, "office-design2-classification.json");
    if (!fs.existsSync(p)) return { clearRects: [], manualPlacements: [], fillDonors: [] };
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      clearRects: raw.clearRects ?? [],
      manualPlacements: raw.manualPlacements ?? [],
      fillDonors: raw.fillDonors ?? [],
    };
  }

  function loadClassification() {
    const p = path.join(__dirname, "office-design2-classification.json");
    if (!fs.existsSync(p)) {
      console.warn("no classification file; collision will be all-solid, no seats");
      return {
        floorTiles: new Set(),
        wallTiles: new Set(),
        solidObjects: new Set(),
        deskTiles: new Set(),
        deskEdges: new Set(),
        seatObjects: new Set(),
        floorPatchObjects: new Set(),
        wallBands: [],
        walkableRects: [],
        carveRects: [],
        solidRects: [],
        spawn: { x: 256, y: 344 },
      };
    }
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      floorTiles: new Set(raw.floorTiles ?? []),
      wallTiles: new Set(raw.wallTiles ?? []),
      solidObjects: new Set(raw.solidObjects ?? []),
      deskTiles: new Set(raw.deskTiles ?? []),
      deskEdges: new Set(raw.deskEdges ?? []),
      seatObjects: new Set(raw.seatObjects ?? []),
      floorPatchObjects: new Set(raw.floorPatchObjects ?? []),
      wallBands: raw.wallBands ?? [],
      walkableRects: raw.walkableRects ?? [],
      carveRects: raw.carveRects ?? [],
      solidRects: raw.solidRects ?? [],
      spawn: raw.spawn ?? { x: 256, y: 344 },
    };
  }
}

void main();
