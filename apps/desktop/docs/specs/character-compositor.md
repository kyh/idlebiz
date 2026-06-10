# SPEC: character-compositor

Verified everything against the actual files. Here is the exact compositing recipe.

---

# Limezu Modular Compositing Recipe (32×32 tier)

## Ground truth (verified by pixel inspection, not docs)

All character-generator layer files are **full pre-rendered spritesheets** — every part PNG already contains all animations × all 4 directions. You stack whole sheets, then slice frames. The `_NN` trailing number is a **color/variant index, NOT an animation frame**.

---

## 1. Layer sheet dimensions + per-frame cell

| Layer set | Sheet dims | Cell | Grid | Notes |
|---|---|---|---|---|
| Bodies | **1854×1312** | 32×32 | 57.9×41 | **Wider than the rest** — extra cols on the right for lift/throw/pushcart anims. Left-origin registration identical to other layers; walk lives at x192–384 so the width delta is irrelevant. |
| Eyes | 1792×1312 | 32×32 | 56×41 | |
| Hairstyles | 1792×1312 | 32×32 | 56×41 | |
| Outfits | 1792×1312 | 32×32 | 56×41 | |
| Accessories | 1792×1312 | 32×32 | 56×41 | |

All share the **same top-left origin and same 32px cell grid**. Stacking at offset (0,0) aligns frame-by-frame — **confirmed**: composited body+eyes+outfit+hair+glasses register perfectly (hair on head, outfit on torso, glasses on face, across all 6 walk frames).

Portrait sheets (`Portrait_Generator_32x32`): **640×192**, cell **64×64**, grid **10 cols × 3 rows = 30 expression frames** (face content ~28–32px centered in each 64px cell). The 16x16 tier is 320×96 (cell 32×32). Use the 32x32 portrait tier to match the 32x32 character tier.

---

## 2. Frame grid + direction map (verified)

Rows are indexed in 32px units from the top. Animation bands are **4 rows each = one row per direction**, in order **DOWN, LEFT, UP, RIGHT** (verified by extracting row 2/3/4/5 at col 8: row2=front face, row3=left profile, row4=back of head, row5=right profile).

Within each direction row, frames are grouped in **column-blocks of 6**:
- **cols 0–5 = IDLE** (6 frames; near-static — measured 40px inter-frame change)
- **cols 6–11 = WALK** (6 frames; striding — measured 128px inter-frame change)

Confirmed against baked text labels inside the body PNG gutter: "idle" label at row 3, "walk" label at row 5.

**WALK frame source cells (the only ones you need):**

| Direction | Source row | Source cols | Cell rect (x,y,w,h) per frame f∈0..5 |
|---|---|---|---|
| down | 2 | 6–11 | ((6+f)·32, 2·32, 32, 32) |
| left | 3 | 6–11 | ((6+f)·32, 3·32, 32, 32) |
| up | 4 | 6–11 | ((6+f)·32, 4·32, 32, 32) |
| right | 5 | 6–11 | ((6+f)·32, 5·32, 32, 32) |

(For idle frames, same rows, cols 0–5.)

Body/eyes/hair/outfit/accessory **all use these identical cells** — verified.

The premade-characters full sheet uses this exact same 56×41 grid, so anything you learn here matches finished Limezu characters.

---

## 3. Naming + counts + cross-generator ID parity (verified)

**Character generator** (`.../Character_Generator/<Part>/32x32/`):
- `Body_32x32_NN.png` — N = **1–9** (9 skin tones)
- `Eyes_32x32_NN.png` — N = **01–07** (7 eye colors)
- `Hairstyle_<ID>_32x32_<V>.png` — ID **01–29**, V = color variant. **IDs 01–26 → 7 variants, IDs 27–29 → 6 variants** (200 files total)
- `Outfit_<ID>_32x32_<V>.png` — ID **01–33**, V = color variant (variant count varies per outfit)
- `Accessory_<ID>_<Name>_32x32_<V>.png` — ID **01–19** with names (Ladybug, Bee, Backpack, Snapback, Dino, Policeman, Bataclava, Detective, Zombie, Bolt, Beanie, Mustache, Beard, Gloves, Glasses, Monocle, Medical, Chef, Party)

**Portrait generator** (`Portrait_Generator_32x32/<Part>_32x32/`):
- `PG_Skin_32x32_N.png` — **1–9** → **matches body N exactly**
- `PG_Eyes_32x32_NN.png` — **01–07** → **matches eyes exactly**
- `PG_Hairstyle_<ID>_32x32_<V>.png` — ID **01–29**, variant counts identical (verified ID01=7/7, ID29=6/6) → **char hair `Hairstyle_07_32x32_3` ↔ portrait `PG_Hairstyle_07_32x32_3` are the same style+color**
- `PG_Accessory_<ID>_<Name>_32x32_<V>.png` — **PARTIAL parity (85 files)**: portrait has only **15 of 19** accessories. Missing on portraits: **02_Bee, 03_Backpack, 14_Gloves, 18_Chef** (body-only items that don't appear on a face). Also note portrait accessories have **4 variants** vs sprite accessories' variable count — variant indices are not guaranteed 1:1; clamp.

**Conclusion:** skin, eyes, hairstyle (ID **and** variant) map 1:1 between the two generators. Accessories need a guard — if the chosen sprite accessory ID isn't in the portrait set, omit it from the portrait.

---

## 4. Individual PNGs vs combined sheet

Each part/variant is an **individual full-animation spritesheet PNG**. A single "style" = pick one file by `<ID>` and `<variant>`. There is no master atlas; you select the file, then slice cells. Portraits are the same: one PNG per skin/eye/hair/accessory variant, each a 30-cell expression sheet.

---

## 5. Compositing algorithm (Node + sharp)

**Z-order (from `CHARACTER_GENERATOR.txt`, verified visually):**
`BODY → EYES → OUTFIT → HAIRSTYLE → ACCESSORY` (bottom → top). Same order works for portraits (skin → eyes → hair → accessory; no outfit).

All layers composite at **offset (0,0)** — no per-layer offset handling needed.

### Walk spritesheet
1. Seed → pick: `bodyN∈1..9`, `eyesN∈1..7`, `outfitId∈1..33`+variant, `hairId∈1..29`+variant (≤7 or ≤6), optional `accId`+variant.
2. Composite the 5 **full sheets** onto the body sheet (body is the base/largest canvas) in z-order → one merged sheet buffer.
3. Slice the 24 walk cells (4 dirs × 6 frames) using the rects in §2 and pack into a tight output grid **6 cols × 4 rows**.
4. **Output: 192×128 PNG**, 32×32 frames, frame order row-major = down[0–5], left[6–11], up[12–17], right[18–23].

**Phaser load config:**
```js
this.load.spritesheet('char', 'char_walk.png', { frameWidth: 32, frameHeight: 32 });
// frames per dir: down 0-5, left 6-11, up 12-17, right 18-23
this.anims.create({ key:'walk-down',  frames:this.anims.generateFrameNumbers('char',{start:0, end:5 }), frameRate:8, repeat:-1 });
this.anims.create({ key:'walk-left',  frames:this.anims.generateFrameNumbers('char',{start:6, end:11}), frameRate:8, repeat:-1 });
this.anims.create({ key:'walk-up',    frames:this.anims.generateFrameNumbers('char',{start:12,end:17}), frameRate:8, repeat:-1 });
this.anims.create({ key:'walk-right', frames:this.anims.generateFrameNumbers('char',{start:18,end:23}), frameRate:8, repeat:-1 });
```

### Portrait
1. Same seed → portrait files: `PG_Skin_32x32_${bodyN}`, `PG_Eyes_32x32_${eyesNN}`, `PG_Hairstyle_${hairId}_32x32_${hairVariant}`, and `PG_Accessory_...` **only if present** in portrait set.
2. Composite at (0,0) in z-order: skin → eyes → hair → accessory.
3. Extract **cell (col 0, row 0)** = rect (0,0,64,64) for a neutral face (or pick another of the 30 expressions).
4. **Output: 64×64 PNG** (or `.extract` then `.trim()` to ~32×32 if you want it tight).

### Reference sharp code (both verified working on disk)
```js
import sharp from 'sharp';

// WALK
const merged = await sharp(bodyPath).composite([
  { input: await sharp(eyesPath).toBuffer() },
  { input: await sharp(outfitPath).toBuffer() },
  { input: await sharp(hairPath).toBuffer() },
  ...(accPath ? [{ input: await sharp(accPath).toBuffer() }] : []),
]).png().toBuffer();

const dirRows = [2, 3, 4, 5]; // down,left,up,right
const tiles = [];
for (let d = 0; d < 4; d++)
  for (let f = 0; f < 6; f++) {
    const c = 6 + f;
    tiles.push({
      input: await sharp(merged).extract({ left: c*32, top: dirRows[d]*32, width: 32, height: 32 }).png().toBuffer(),
      top: d*32, left: f*32,
    });
  }
await sharp({ create:{ width:192, height:128, channels:4, background:{r:0,g:0,b:0,alpha:0} } })
  .composite(tiles).png().toFile('char_walk.png');

// PORTRAIT
const face = await sharp(pgSkinPath).composite([
  { input: await sharp(pgEyesPath).toBuffer() },
  { input: await sharp(pgHairPath).toBuffer() },
  ...(pgAccPath ? [{ input: await sharp(pgAccPath).toBuffer() }] : []),
]).png().toBuffer();
await sharp(face).extract({ left:0, top:0, width:64, height:64 }).png().toFile('portrait.png');
```

---

## 6. License notes

Four files present:
- `/Users/kyh/Desktop/vg/office/moderninteriors-win/LICENSE.txt` — "MODERN INTERIORS FULL VERSION LICENSE". CAN: edit + use in any commercial/non-commercial project. CANNOT: resell/distribute the asset or edit-and-resell. **Credits required (limezu.itch.io)**.
- `/Users/kyh/Desktop/vg/office/modernuserinterface-win/LICENSE.txt` — "MODERN USER INTERFACE LICENSE". Same terms **plus explicit no-NFT-minting**. Credits required.
- Two `READ_ME.txt` (no extra legal terms).

Net: commercial OK, **credit Limezu**, don't redistribute raw assets, no NFTs (UI pack). Your composited output is a derived in-game asset — fine; just don't ship the source PNGs as a resellable pack.

---

## Key paths
- Bodies: `/Users/kyh/Desktop/vg/office/moderninteriors-win/2_Characters/Character_Generator/Bodies/32x32/Body_32x32_<1-9>.png`
- Eyes: `.../Eyes/32x32/Eyes_32x32_<01-07>.png`
- Hair: `.../Hairstyles/32x32/Hairstyle_<01-29>_32x32_<variant>.png`
- Outfits: `.../Outfits/32x32/Outfit_<01-33>_32x32_<variant>.png`
- Accessories: `.../Accessories/32x32/Accessory_<01-19>_<Name>_32x32_<variant>.png`
- Premade ref: `.../Character_Generator/0_Premade_Characters/Premade_Characters_LIST.png` (note: lives under `Character_Generator/`, not directly under `2_Characters/`)
- Portrait (32x32): `/Users/kyh/Desktop/vg/office/modernuserinterface-win/32x32/Portrait_Generator_32x32/{Skins_32x32,Eyes_32x32,Hairstyles_32x32,Accessories_32x32}/PG_*.png`
- Order spec: `.../Character_Generator/CHARACTER_GENERATOR.txt`

---

## Gotchas / my take
- **Body sheet is 1854 wide, others 1792** — do NOT center or right-align when stacking; always composite at (0,0). Walk is at x192–384 so it's safe, but if you ever pull right-side anims (lift/throw) only the body has them.
- **Accessory portrait parity is incomplete** (15/19). Build a `PORTRAIT_ACCESSORIES` allowlist and skip on portrait if absent. Also accessory variant counts differ between generators — clamp the variant index.
- **Outfit exception**: kids pajama outfits 6 & 7 don't take a hairstyle (per the txt). Irrelevant if you only use adult `Outfits/`, but guard if you ever touch `Outfits_kids`.
- The idle block (cols 0–5) is free if you want a standing animation later — same recipe, just shift the col offset.
- Portrait cell is **64×64 padded** (content ~32px). If your UI wants a tight headshot, `.trim()` after extract.
- Everything here is verified by compositing real files and inspecting pixels — the `FINAL_walk.png` (192×128, 24 frames) and `portrait_cell00.png` (64×64) both rendered correctly with all 5 / 3 layers aligned.
