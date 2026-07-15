// Relax over-lifted object anchors in office-design.json.
//
// Inside the entity band, `anchorY` still serves two masters. It fixes the draw order
// among overlapping objects (the static composite must stay pixel-exact to the pack
// reference), and it is the floor line characters y-sort against. generate-office-design2
// tunes it purely for the first: its wall-band pass lifts ANY object whose anchor lands in
// a band rect up to that band's floor line, which sweeps up free-standing furniture
// (chairs, plants) parked in front of a divider. A chair lifted 36px past its own base
// then draws over anyone standing well in front of it — the character's head vanishes
// behind a chair they are walking past.
//
// This is now the ONLY place the two masters collide: the flat bands carry no anchor at
// all (they paint in array order), so the generator cannot inflate one. Only the entity
// band, where furniture and actors genuinely share a sort key, still needs the squeeze.
//
// The minimal anchor that still preserves the composite is a topological one. Objects
// later in the array draw over earlier ones they overlap, so for every overlapping pair
// (i before k) we need anchorY(k) >= anchorY(i) — equal is fine, since ties fall back to
// array order and k still wins. Relaxing each piece to its OWN base independently breaks
// this (it can invert a pair); taking the running max does not:
//
//     anchorY(k) = max( trueContentBottom(k), max{ anchorY(i) : i < k, overlaps(i, k) } )
//
// That is the lowest honest floor line each piece can have. The reference render is still
// used as an oracle afterwards: we re-render and refuse to write unless the composite is
// byte-identical.
//
// The shipped office-design.json is now hand-authored; this ran as pass 3 of the pipeline
// that seeded it (generate -> remove-people -> relax -> prune). It rewrites the live layout
// in place — diff before you commit.
//
// Usage: node scripts/relax-office-anchors.cjs [--write]
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");
const { writeLayout } = require("./lib/office-layout-file.cjs");

const appRoot = path.resolve(__dirname, "..");
const LAYOUT = path.join(appRoot, "src/renderer/game/office-design.json");
const PUB = path.join(appRoot, "public");
const TMP = "/tmp/relax-anchors";
const WRITE = process.argv.includes("--write");

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

const maskCache = new Map();
async function mask(rel) {
  if (maskCache.has(rel)) return maskCache.get(rel);
  const { data, info } = await sharp(path.join(PUB, rel))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const opaque = new Uint8Array(info.width * info.height);
  let bottom = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const on = data[(y * info.width + x) * 4 + 3] > 0;
      opaque[y * info.width + x] = on ? 1 : 0;
      if (on && y > bottom) bottom = y;
    }
  }
  const entry = { opaque, w: info.width, h: info.height, bottom };
  maskCache.set(rel, entry);
  return entry;
}

/** World-space opaque test, honouring the placement's flips. */
function opaqueAt(p, wx, wy) {
  const x = wx - p.o.x;
  const y = wy - p.o.y;
  if (x < 0 || y < 0 || x >= p.m.w || y >= p.m.h) return false;
  const lx = p.o.flipX ? p.m.w - 1 - x : x;
  const ly = p.o.flipY ? p.m.h - 1 - y : y;
  return p.m.opaque[ly * p.m.w + lx] === 1;
}

function overlaps(a, b) {
  const x0 = Math.max(a.o.x, b.o.x);
  const x1 = Math.min(a.o.x + a.m.w, b.o.x + b.m.w);
  const y0 = Math.max(a.o.y, b.o.y);
  const y1 = Math.min(a.o.y + a.m.h, b.o.y + b.m.h);
  if (x1 <= x0 || y1 <= y0) return false;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (opaqueAt(a, x, y) && opaqueAt(b, x, y)) return true;
    }
  }
  return false;
}

function render(layout, out) {
  fs.mkdirSync(TMP, { recursive: true });
  const tmp = path.join(TMP, "layout.json");
  fs.writeFileSync(tmp, JSON.stringify(layout));
  execFileSync("node", [path.join(__dirname, "render-office-preview.cjs"), "--layout", tmp, out]);
}

async function pixels(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

(async () => {
  const layout = JSON.parse(fs.readFileSync(LAYOUT, "utf8"));

  const baseline = path.join(TMP, "baseline.png");
  render(layout, baseline);
  const before = await pixels(baseline);

  // object-layer placements, in array order = draw order
  const items = [];
  for (const o of layout.objects) {
    if (o.layer !== "object") continue;
    const rel = o.path ?? catalogPath.get(o.id);
    if (!rel) continue;
    const m = await mask(rel);
    if (m.bottom < 0) continue;
    items.push({ o, m, was: o.anchorY, trueBottom: o.y + m.bottom + 1 });
  }
  console.log(`${items.length} object placements`);

  // topological relax: anchor = max(own base, every earlier overlapping anchor)
  for (let k = 0; k < items.length; k++) {
    let anchor = items[k].trueBottom;
    for (let i = 0; i < k; i++) {
      if (items[i].o.anchorY <= anchor) continue; // cannot raise the running max
      if (!overlaps(items[i], items[k])) continue;
      anchor = items[i].o.anchorY;
    }
    items[k].o.anchorY = anchor;
  }

  console.log(
    `phase 1 (topological): lowered ${items.filter((it) => it.o.anchorY < it.was).length}`,
  );

  // Phase 2 — squeeze. The topological rule is conservative: two pieces may overlap in
  // pixels that are the SAME colour, in which case their order is free. Only the render
  // can tell. Drop every still-lifted anchor to its base, re-render, and put back any
  // piece that moved a pixel; repeat until the composite is clean again.
  // `committed` is the last anchor set proven to render byte-identically. Every round
  // squeezes from there; a round that dirties the composite is rolled all the way back,
  // and only the pieces we can blame are frozen, so the next round retries the rest.
  const snapshot = () => items.map((it) => it.o.anchorY);
  const restore = (snap) => items.forEach((it, n) => (it.o.anchorY = snap[n]));
  let committed = snapshot();
  const frozen = new Set();

  for (let round = 1; round <= 10; round++) {
    const live = items.filter((it) => !frozen.has(it) && it.o.anchorY > it.trueBottom);
    if (live.length === 0) break;
    for (const it of live) it.o.anchorY = it.trueBottom;

    const out = path.join(TMP, `squeeze-${round}.png`);
    render(layout, out);
    const now = await pixels(out);
    const broken = new Set();
    for (let i = 0; i < before.w * before.h; i++) {
      if (
        before.data[i * 4] !== now.data[i * 4] ||
        before.data[i * 4 + 1] !== now.data[i * 4 + 1] ||
        before.data[i * 4 + 2] !== now.data[i * 4 + 2] ||
        before.data[i * 4 + 3] !== now.data[i * 4 + 3]
      )
        broken.add(i);
    }
    if (broken.size === 0) {
      committed = snapshot();
      console.log(`phase 2 round ${round}: squeezed ${live.length}, composite clean`);
      continue;
    }

    const blamed = live.filter((it) => {
      for (let y = it.o.y; y < it.o.y + it.m.h; y++) {
        for (let x = it.o.x; x < it.o.x + it.m.w; x++) {
          if (x < 0 || y < 0 || x >= before.w || y >= before.h) continue;
          if (opaqueAt(it, x, y) && broken.has(y * before.w + x)) return true;
        }
      }
      return false;
    });
    restore(committed); // always fall back to a known-clean composite
    for (const it of blamed) frozen.add(it);
    console.log(
      `phase 2 round ${round}: ${broken.size} px moved -> froze ${blamed.length}, retrying the rest`,
    );
    if (blamed.length === 0) {
      console.log("  diff not attributable to any candidate — stopping");
      break;
    }
  }
  restore(committed);

  const lowered = items.filter((it) => it.o.anchorY < it.was);
  const drops = lowered.map((it) => it.was - it.o.anchorY).toSorted((a, b) => b - a);
  console.log(`\nlowered ${lowered.length}/${items.length} anchors toward their true floor line`);
  if (drops.length) console.log(`  drop: max ${drops[0]}px, median ${drops[drops.length >> 1]}px`);
  const stillLifted = items.filter((it) => it.o.anchorY > it.trueBottom);
  console.log(
    `  ${stillLifted.length} must stay above their base to keep drawing over what they overlap`,
  );

  // oracle: the composite must not move a single byte
  const after = path.join(TMP, "relaxed.png");
  render(layout, after);
  const now = await pixels(after);
  let diff = 0;
  for (let i = 0; i < before.data.length; i++) if (before.data[i] !== now.data[i]) diff++;
  console.log(`\ncomposite vs baseline: ${diff} bytes differ`);
  if (diff !== 0) throw new Error("composite changed — refusing to write");

  if (WRITE) {
    writeLayout(layout, LAYOUT);
    console.log(`wrote ${LAYOUT}`);
  } else {
    console.log("(dry run — pass --write to save)");
  }
})();
