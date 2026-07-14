// Strip the painted humans out of office-design.json.
//
// The Modern Office pack draws people INTO some of its furniture singles, and the
// reconstruction placed them faithfully. The result is four permanent strangers in the
// office who are not your agents: two faces filling a monitor screen (a video call) and
// two framed desk portraits. They read as employees at gameplay zoom, which is confusing
// next to the real, live NPCs.
//
// Two different removals, because the sprites are two different things:
//   * The video-call monitors keep their bezel and stand — only the SCREEN is repainted,
//     to the light fill the screen already uses above the face. The monitor survives; it
//     just shows a blank window now. Every placement painting into the screen rect gets a
//     variant PNG (the figure straddles two sprites), so no other placement is touched.
//   * The framed portraits are nothing BUT a framed portrait, so the placement is dropped
//     and the desk keeps whatever was under it.
//
// Verified two ways: the render must contain zero character-skin pixels afterwards, and
// nothing outside the intended regions may change.
//
// Run after generate-office-design2.cjs (which would re-introduce them), before
// relax-office-anchors.cjs.
//
// Usage: node scripts/remove-office-people.cjs [--write]
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");

const appRoot = path.resolve(__dirname, "..");
const LAYOUT = path.join(appRoot, "src/renderer/game/office-design.json");
const PUB = path.join(appRoot, "public");
const OUT_DIR = path.join(PUB, "workspace-kit/design2");
const TMP = "/tmp/remove-people";
const WRITE = process.argv.includes("--write");

/** Screens whose picture is a person. `fill` is the screen's own light colour. */
const SCREENS = [
  { name: "video-call monitor (blonde)", rect: [156, 112, 172, 124], fill: [0xd4, 0xde, 0xe6] },
  { name: "video-call monitor (auburn)", rect: [316, 240, 332, 252], fill: [0xd4, 0xde, 0xe6] },
];

/** Placements that are nothing but a framed portrait. */
const DROP = [
  { id: "office-object-160", x: 186, y: 176 },
  { id: "office-object-232", x: 352, y: 64 },
];

/** Skin tones used by the pack's character art — the success check. */
const SKIN = new Set([0xffb893, 0xf69784, 0xffc9a8, 0xffd5b8, 0xe89f7a]);

const catalogSrc = fs.readFileSync(
  path.join(appRoot, "src/renderer/game/office-object-catalog.generated.ts"),
  "utf8",
);
const catalogPath = new Map();
{
  const re = /id:\s*"(office-object-\d+)"[\s\S]*?variants:\s*\[([\s\S]*?)\n\s{4}\],/g;
  let m;
  while ((m = re.exec(catalogSrc))) {
    const v = /scale:\s*32,\s*path:\s*"([^"]+)"/.exec(m[2]);
    if (v) catalogPath.set(m[1], v[1]);
  }
}
const assetOf = (o) => o.path ?? catalogPath.get(o.id);

/** Byte offset of world pixel (wx, wy) inside a placement's texture, or -1 if outside. */
function localOf(s, wx, wy) {
  const x = wx - s.o.x;
  const y = wy - s.o.y;
  if (x < 0 || y < 0 || x >= s.img.w || y >= s.img.h) return -1;
  const lx = s.o.flipX ? s.img.w - 1 - x : x;
  const ly = s.o.flipY ? s.img.h - 1 - y : y;
  return (ly * s.img.w + lx) * 4;
}

function render(layout, out) {
  fs.mkdirSync(TMP, { recursive: true });
  const tmp = path.join(TMP, "layout.json");
  fs.writeFileSync(tmp, JSON.stringify(layout));
  execFileSync("node", [path.join(__dirname, "render-office-preview.cjs"), "--layout", tmp, out]);
}
const raw = async (f) => {
  const { data, info } = await sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
};

(async () => {
  const layout = JSON.parse(fs.readFileSync(LAYOUT, "utf8"));
  const beforePng = path.join(TMP, "before.png");
  render(layout, beforePng);
  const before = await raw(beforePng);

  // ---- 1. repaint the screens ----
  // Only the placement that is actually VISIBLE at each screen pixel gets repainted;
  // anything buried under the monitor is left alone (it can't show through anyway, and a
  // variant PNG per hidden floor tile would be pure litter).
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const OVERHEAD = 1_500_000;
  const depthOf = (o) =>
    o.layer === "floor"
      ? 1 + o.anchorY * 1e-4
      : o.layer === "overhead"
        ? OVERHEAD + Math.min(o.anchorY, 499_999)
        : 1000 + o.anchorY + 0.5;

  const sprites = [];
  for (const [index, o] of layout.objects.entries()) {
    const rel = assetOf(o);
    if (!rel) continue;
    sprites.push({ o, index, rel, depth: depthOf(o), img: await raw(path.join(PUB, rel)) });
  }
  // draw order: depth, then array order (Phaser's stable tie-break)
  const drawOrder = sprites.toSorted((a, b) => a.depth - b.depth || a.index - b.index);

  const repaint = new Map(); // sprite -> count
  for (const { rect, fill } of SCREENS) {
    const [rx0, ry0, rx1, ry1] = rect;
    for (let wy = ry0; wy < ry1; wy++) {
      for (let wx = rx0; wx < rx1; wx++) {
        let top = null;
        for (const s of drawOrder) {
          const i = localOf(s, wx, wy);
          if (i < 0 || s.img.data[i + 3] === 0) continue;
          top = { s, i };
        }
        if (!top) continue;
        top.s.img.data[top.i] = fill[0];
        top.s.img.data[top.i + 1] = fill[1];
        top.s.img.data[top.i + 2] = fill[2];
        repaint.set(top.s, (repaint.get(top.s) ?? 0) + 1);
      }
    }
  }
  for (const [s, n] of repaint) {
    const variantId = `d2-noface-${s.o.id}-${s.o.x}-${s.o.y}`;
    const outRel = `workspace-kit/design2/${variantId}.png`;
    await sharp(s.img.data, { raw: { width: s.img.w, height: s.img.h, channels: 4 } })
      .png()
      .toFile(path.join(PUB, outRel));
    console.log(`  repainted ${n} visible screen px in ${s.o.id}@(${s.o.x},${s.o.y})`);
    s.o.path = outRel;
  }
  console.log(`repainted ${repaint.size} placements across ${SCREENS.length} screens`);

  // ---- 2. drop the framed portraits ----
  let dropped = 0;
  for (const d of DROP) {
    const i = layout.objects.findIndex((o) => o.id === d.id && o.x === d.x && o.y === d.y);
    if (i < 0) {
      console.warn(`  ${d.id}@(${d.x},${d.y}) not found — already gone?`);
      continue;
    }
    layout.objects.splice(i, 1);
    dropped++;
    console.log(`  dropped ${d.id}@(${d.x},${d.y}) (framed portrait)`);
  }
  console.log(`dropped ${dropped} portrait placements`);

  // ---- 3. verify ----
  const afterPng = path.join(TMP, "after.png");
  render(layout, afterPng);
  const after = await raw(afterPng);

  const skinLeft = [];
  for (let y = 0; y < after.h; y++) {
    for (let x = 0; x < after.w; x++) {
      const i = (y * after.w + x) * 4;
      if (!after.data[i + 3]) continue;
      const c = (after.data[i] << 16) | (after.data[i + 1] << 8) | after.data[i + 2];
      if (SKIN.has(c)) skinLeft.push(`${x},${y}`);
    }
  }
  console.log(`\ncharacter-skin pixels left in the office: ${skinLeft.length}`);
  if (skinLeft.length) console.log(`  at ${skinLeft.slice(0, 20).join(" ")}`);

  // nothing may change outside the screens + the dropped portraits' footprints
  const allowed = (x, y) => {
    for (const { rect } of SCREENS)
      if (x >= rect[0] && x < rect[2] && y >= rect[1] && y < rect[3]) return true;
    for (const d of DROP) if (x >= d.x && x < d.x + 64 && y >= d.y && y < d.y + 96) return true;
    return false;
  };
  let stray = 0;
  let changed = 0;
  for (let y = 0; y < after.h; y++) {
    for (let x = 0; x < after.w; x++) {
      const i = (y * after.w + x) * 4;
      const same =
        before.data[i] === after.data[i] &&
        before.data[i + 1] === after.data[i + 1] &&
        before.data[i + 2] === after.data[i + 2] &&
        before.data[i + 3] === after.data[i + 3];
      if (same) continue;
      changed++;
      if (!allowed(x, y)) stray++;
    }
  }
  console.log(`pixels changed: ${changed} (${stray} outside the intended regions)`);
  if (stray > 0)
    throw new Error("collateral damage outside the target regions — refusing to write");
  if (skinLeft.length > 0) throw new Error("people still visible — refusing to write");

  if (WRITE) {
    fs.writeFileSync(LAYOUT, JSON.stringify(layout, null, 1));
    console.log(`\nwrote ${LAYOUT}`);
  } else {
    console.log("\n(dry run — pass --write to save)");
  }
})();
