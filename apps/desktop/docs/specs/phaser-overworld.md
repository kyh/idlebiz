# SPEC: phaser-overworld

I now have all the patterns I need. Compiling the complete answer with concrete, copyable code adapted to the office/NPC use case, quoting real farm snippets where load-bearing.

# Phaser 4 Office Game — Concrete Patterns (adapted from vibedgames `farm`/`bomberman`)

Key fact: farm pins `phaser@^4.1.0` and never uses Tiled. It builds the world from a 2D-ish `World` model + per-tile `add.image`/`tileSprite` blitting, with **manual AABB collision against a tile-solidity function — no arcade colliders.** That's the pattern to copy for an office. Below, every snippet is adapted for a top-down walkable office with press-A interact.

---

## 1. Game config + scene structure (Boot / Preload / World)

Farm uses one `BootScene` that does both load + anim-create, then starts gameplay. For an office, keep that but rename to match Boot→Preload→World intent. `src/main.ts` (real farm config):

```ts
// src/main.ts — quoted from farm, renamed scenes
import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { OfficeScene } from "./scenes/OfficeScene";
import { HudScene } from "./scenes/HudScene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  backgroundColor: "#1c2030",
  scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
  pixelArt: true,          // crisp Limezu pixels
  roundPixels: true,
  physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
  scene: [BootScene, OfficeScene, HudScene],
};

new Phaser.Game(config);
```

`index.html` needs `<div id="game"></div>`, `image-rendering: pixelated`, and a `#veil` loading overlay you hide in `create()` with `document.getElementById("veil")?.classList.add("hidden")` (farm does exactly this on line 87 of GameScene).

> ESM gotcha (from SKILL.md): Phaser 4 sets **no global `Phaser`**. Farm uses `import Phaser from "phaser"` (default import) in every scene — that works. If you switch to `import { Scene }`, you must add `import * as Phaser from "phaser"` in any file using `Phaser.Math.*`, `Phaser.Scenes.Events`, etc. as runtime values, or you get `ReferenceError: Phaser is not defined`.

`config.ts` constants (farm pattern — note source art is 16px there; for Limezu use **16**, see §7):

```ts
export const TILE = 16;          // Limezu Modern Office is 16px-native
export const ZOOM = 3.25;
export const MAP_W = 30;         // office room in tiles
export const MAP_H = 20;
export const WALK_SPEED = 62;    // px/sec pre-zoom
export const DEPTH = { ground: 0, decalLow: 3, entityBase: 10, ui: 1_000_000 } as const;
```

---

## 2. Tilemap: build the office room. **Recommendation: 2D-array → tile blitting** (the farm approach)

You have raw PNG tilesets/singles, no Tiled JSON. Three options:

| Approach | Verdict for a small office |
|---|---|
| Hand-author Tiled JSON | Overkill. Requires opening Tiled, slicing the Limezu sheet into a `.tsx`, painting, exporting, matching layer names. High friction for one room. |
| `createBlankLayer` + `putTileAt` (needs a single sliced tileset PNG via `load.spritesheet`) | Viable if you slice Limezu into one indexed sheet. Gives you real `TilemapLayer` + `setCollisionByExclusion`. |
| **2D-array → blit `add.image` per cell + a `solid` Set** | **Recommended.** Matches farm exactly, zero tooling, works with Limezu "singles" PNGs, trivial collision. |

Use the array approach. Load each office tile as its own image (like farm loads `t-grass0..5`, `t-water`), define the room as a char grid, blit, and record solid cells:

```ts
// BootScene.preload() — load office singles (16x16 each)
this.load.image("floor", "assets/tiles/floor.png");
this.load.image("rug",   "assets/tiles/rug.png");
this.load.image("wall",  "assets/tiles/wall.png");        // single tile or top-of-wall
this.load.image("wall-top", "assets/tiles/wall_top.png");
this.load.image("desk",  "assets/props/desk.png");        // 16x16 or multi-tile prop
this.load.image("plant", "assets/props/plant.png");
this.load.image("printer","assets/props/printer.png");
```

```ts
// OfficeScene — build room from a 2D char map. '.' floor, '#' wall, 'D' desk, 'P' plant
const ROOM = [
  "##############################",
  "#............................#",
  "#..D.D.D......P..........D.D..#",
  "#............................#",
  "#............rrrr.............#",
  "#............rrrr....printer..#",
  // ...
];

private solid = new Set<number>();           // tile index ty*MAP_W+tx
private idx(tx: number, ty: number) { return ty * MAP_W + tx; }

private buildRoom(): void {
  // continuous floor underlay (farm uses tileSprite for the grass base)
  this.add.tileSprite(0, 0, MAP_W * TILE, MAP_H * TILE, "floor")
    .setOrigin(0, 0).setDepth(DEPTH.ground);

  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const ch = ROOM[ty]?.[tx] ?? ".";
      const x = tx * TILE, y = ty * TILE;
      if (ch === "#") {
        this.add.image(x, y, "wall").setOrigin(0, 0).setDepth(DEPTH.ground + 1);
        this.solid.add(this.idx(tx, ty));
      } else if (ch === "D") {
        // y-sorted prop so the player can stand behind the desk
        const by = (ty + 1) * TILE;
        this.add.image(tx * TILE + TILE / 2, by, "desk")
          .setOrigin(0.5, 1).setDepth(DEPTH.entityBase + by);
        this.solid.add(this.idx(tx, ty));            // desk blocks
      } else if (ch === "P") {
        const by = (ty + 1) * TILE;
        this.add.image(tx * TILE + TILE / 2, by, "plant").setOrigin(0.5, 1)
          .setDepth(DEPTH.entityBase + by);
        this.solid.add(this.idx(tx, ty));
      }
    }
  }
}

isSolidTile(tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return true;   // OOB = wall
  return this.solid.has(this.idx(tx, ty));
}
```

This mirrors farm's `world.isSolidTile()` (world.ts lines 93–98) which checks ground type + object footprint. Multi-tile props (a 2×1 desk): mark every covered tile in `solid` and place one sprite anchored bottom-center.

---

## 3. Player: walk spritesheet, 4-dir anims, free arcade movement + collision, camera follow

Farm uses **one omnidirectional sheet flipped horizontally** (no separate up/down sheets — it relies on `setFlipX`). Bomberman uses **3 directional sheets** (`player-up`, `player-down`, `player-side`, with `side` flipped for left). For an office with proper 4-dir facing, use bomberman's 3-sheet + flip approach.

**Load + anims** (bomberman BootScene, real):

```ts
// preload — Limezu char walk sheets, 16x16 frames (see §7)
const f = { frameWidth: 16, frameHeight: 32 };  // Limezu chars are 16w x 32h
this.load.spritesheet("p-down", "assets/char/player_down.png", f);
this.load.spritesheet("p-up",   "assets/char/player_up.png",   f);
this.load.spritesheet("p-side", "assets/char/player_side.png", f);

// create — quoted shape from bomberman BootScene.create()
const mk = (key: string, sheet: string) =>
  this.anims.create({
    key,
    frames: this.anims.generateFrameNumbers(sheet, { start: 0, end: 3 }),
    frameRate: 9, repeat: -1,
  });
mk("walk-down", "p-down");
mk("walk-up", "p-up");
mk("walk-side", "p-side");
```

**Free movement + manual collision + camera** (adapted from farm GameScene `handleMovement`/`moveResolved`/camera setup — farm uses manual AABB, *not* arcade colliders, even though arcade is enabled):

```ts
// create()
this.player = this.add.sprite(spawnX, spawnY, "p-down", 0).setOrigin(0.5, 0.9);
const cam = this.cameras.main;
cam.setBounds(0, 0, MAP_W * TILE, MAP_H * TILE);   // farm line 135
cam.setZoom(ZOOM);
cam.startFollow(this.player, true, 0.12, 0.12);    // smooth lerp follow
cam.setRoundPixels(true);
this.cursors = this.input.keyboard!.createCursorKeys();
this.keys = this.input.keyboard!.addKeys("W,A,S,D") as Record<string, Phaser.Input.Keyboard.Key>;

// update(_t, dms)
override update(_t: number, dms: number): void {
  const dt = Math.min(dms, 50) / 1000;            // frame-rate independent (farm)
  let dx = 0, dy = 0;
  if (this.keys.A.isDown || this.cursors.left.isDown)  dx -= 1;
  if (this.keys.D.isDown || this.cursors.right.isDown) dx += 1;
  if (this.keys.W.isDown || this.cursors.up.isDown)    dy -= 1;
  if (this.keys.S.isDown || this.cursors.down.isDown)  dy += 1;

  const moving = dx !== 0 || dy !== 0;
  if (moving) {
    if (dx !== 0) this.facing = { x: Math.sign(dx), y: 0 };
    else          this.facing = { x: 0, y: Math.sign(dy) };
    const len = Math.hypot(dx, dy) || 1;
    this.moveResolved((dx / len) * WALK_SPEED * dt, (dy / len) * WALK_SPEED * dt);
    this.applyWalkAnim(dx, dy);
  } else {
    this.player.anims.stop();   // or play idle frame: this.player.setTexture(idleTex, 0)
  }
  this.player.setDepth(DEPTH.entityBase + this.player.y);   // y-sort vs desks
}

// quoted/adapted from farm moveResolved() — axis-separated AABB so you slide along walls
private moveResolved(mx: number, my: number): void {
  const hw = 4, hh = 3;                     // half-body in px
  const solid = (x: number, y: number) =>
    this.isSolidTile(Math.floor(x / TILE), Math.floor(y / TILE));
  const collides = (px: number, py: number) =>
    solid(px - hw, py - hh) || solid(px + hw, py - hh) ||
    solid(px - hw, py + hh) || solid(px + hw, py + hh);
  const nx = this.player.x + mx;
  if (!collides(nx, this.player.y)) this.player.x = nx;
  const ny = this.player.y + my;
  if (!collides(this.player.x, ny)) this.player.y = ny;
}

private applyWalkAnim(dx: number, dy: number): void {
  // pick sheet by dominant axis; flip side sheet for left (bomberman pattern)
  if (dy < 0)      this.player.play("walk-up", true);
  else if (dy > 0) this.player.play("walk-down", true);
  else { this.player.play("walk-side", true); this.player.setFlipX(dx < 0); }
}
```

If you'd rather use **real arcade physics + tile colliders**: slice Limezu into one tileset PNG, build a `TilemapLayer`, `layer.setCollisionByExclusion([-1])` or `setCollisionByProperty`, then `this.physics.add.collider(player, layer)` and drive with `player.body.setVelocity(...)`. But for one room, farm's manual AABB is simpler and is the house style.

---

## 4. NPC employees: static sprites with idle/working anims + adjacency-faces-A interact, emit to React

Farm's `NpcManager` (entities/npcs.ts) is the template. NPCs are plain `add.sprite` (not physics bodies), driven each frame, and `tryTalk(tx, ty)` checks adjacency to the **target tile** the player faces. Interaction is triggered from the player's action handler.

**Data** (farm data/npcs.ts shape, office-flavored):

```ts
export type NpcId = "ada" | "rob" | "mei";
export type NpcState = "working" | "idle" | "blocked";
export type NpcDef = {
  id: NpcId; name: string; role: string;
  homeTile: { tx: number; ty: number };
  deskFacing: { x: number; y: number };   // which way they sit
  lines: string[];
};
export const NPCS: Record<NpcId, NpcDef> = {
  ada: { id: "ada", name: "Ada", role: "Backend",  homeTile: { tx: 6,  ty: 4 }, deskFacing: {x:0,y:1}, lines:["Deploy's green.","CI is flaky again."] },
  rob: { id: "rob", name: "Rob", role: "Design",   homeTile: { tx: 14, ty: 4 }, deskFacing: {x:0,y:1}, lines:["Reviewing the new flow."] },
  mei: { id: "mei", name: "Mei", role: "PM",       homeTile: { tx: 22, ty: 4 }, deskFacing: {x:0,y:1}, lines:["Standup in 5."] },
};
export const NPC_IDS = Object.keys(NPCS) as NpcId[];
```

**Manager** (adapted from farm entities/npcs.ts — `spawnAll`, `update`, `tryTalk`):

```ts
type Live = { id: NpcId; spr: Phaser.GameObjects.Sprite; emote?: Phaser.GameObjects.Sprite; state: NpcState };

export class NpcManager {
  private live: Live[] = [];
  constructor(private scene: OfficeScene) {}

  spawnAll(): void {
    for (const id of NPC_IDS) {
      const def = NPCS[id];
      const x = def.homeTile.tx * TILE + 8, y = def.homeTile.ty * TILE + 14;
      const spr = this.scene.add.sprite(x, y, "npc-idle", 0).setOrigin(0.5, 0.9);
      spr.setDepth(DEPTH.entityBase + y);
      this.live.push({ id, spr, state: "idle" });
    }
  }

  // adapted from farm tryTalk(): adjacency to the tile the player FACES
  tryInteract(tx: number, ty: number): boolean {
    for (const l of this.live) {
      const nx = Math.floor(l.spr.x / TILE), ny = Math.floor((l.spr.y - 1) / TILE);
      if (Math.abs(nx - tx) <= 1 && Math.abs(ny - ty) <= 1) {
        l.spr.setFlipX(this.scene.player.x < l.spr.x);    // NPC turns to face player
        const def = NPCS[l.id];
        this.scene.events.emit("npc-interact", {           // -> Phaser EventEmitter (see below)
          id: l.id, name: def.name, role: def.role,
          text: def.lines[0] ?? "Hi.", state: l.state,
        });
        return true;
      }
    }
    return false;
  }
}
```

**Wire the A/Space press** in the player action handler (farm GameScene: `this.keys.SPACE.on("down", () => this.tryAction())` plus `E`). `targetTile()` is the cell in front of the player:

```ts
// farm GameScene.targetTile() — the tile the player faces
targetTile(): { tx: number; ty: number } {
  const tx = Math.floor(this.player.x / TILE);
  const ty = Math.floor((this.player.y - 1) / TILE);
  return { tx: tx + this.facing.x, ty: ty + this.facing.y };
}

private setupInput(): void {
  const kb = this.input.keyboard!;
  this.actionA = kb.addKey(Phaser.Input.Keyboard.KeyCodes.A);      // press-A
  kb.addKey("SPACE").on("down", () => this.tryAction());
  this.actionA.on("down", () => this.tryAction());                 // (rebind A off WASD if A=left)
}

private tryAction(): void {
  const { tx, ty } = this.targetTile();
  if (this.npcs.tryInteract(tx, ty)) return;
  // ...other interactables (printer, coffee machine)
}
```

Note: farm binds movement to `A` (strafe-left). If you want a dedicated press-A **interact**, use **Space/E for interact** and keep A for movement (cleanest), OR drop A from the movement set and make A=interact. Pick one — don't double-bind.

**Emit up to React** — two real patterns in the repo:

1. **In-Phaser events (farm).** NPC manager calls `this.scene.events.emit("npc-interact", payload)`; a HUD scene listens `this.g.events.on("npc-interact", ...)` (see farm HudScene `this.g.events.on("dialogue", ...)`, line 124).

2. **Phaser → external React/DOM.** Use the game-level emitter, which any React component can subscribe to:

```ts
// inside a scene: bubble the event to the global game emitter
this.game.events.emit("npc-interact", payload);
```
```tsx
// React side
import { useEffect, useState } from "react";
import type { Game } from "phaser";

export function useNpcDialogue(game: Game | null) {
  const [dialogue, setDialogue] = useState<null | { name: string; text: string }>(null);
  useEffect(() => {
    if (!game) return;
    const on = (p: { name: string; text: string }) => setDialogue(p);
    game.events.on("npc-interact", on);
    return () => { game.events.off("npc-interact", on); };
  }, [game]);
  return dialogue;
}
```

(Bomberman shows the simpler non-React variant: the scene writes directly into DOM nodes — `document.getElementById("status")`, `this.statusEl.textContent = ...`. Use that if your HUD is plain HTML like bomberman's `#hud` overlay, not React.)

---

## 5. Drive NPC visible state from external data (working = typing anim; blocked = alert emote)

Farm tints NPCs from data (`spr.setTint(def.tint)`) and swaps anims by comparing the current key (`if (l.spr.anims.currentAnim?.key !== "p-walk") l.spr.play("p-walk", true)`). Same idea, driven by an external `state`:

```ts
// preload: Limezu UI emote sheet (speech bubbles/alerts). 16x16 frames typical.
this.load.spritesheet("emotes", "assets/ui/emotes.png", { frameWidth: 16, frameHeight: 16 });
// in BootScene.create(): typing loop + alert pulse
this.anims.create({ key: "npc-typing", frames: this.anims.generateFrameNumbers("npc-work", {}), frameRate: 8, repeat: -1 });
this.anims.create({ key: "npc-idle-a", frames: this.anims.generateFrameNumbers("npc-idle", {}), frameRate: 4, repeat: -1 });
```

```ts
// NpcManager: apply state coming from outside (e.g. a websocket/store push)
setState(id: NpcId, state: NpcState): void {
  const l = this.live.find((x) => x.id === id);
  if (!l) return;
  l.state = state;

  if (state === "working") {
    if (l.spr.anims.currentAnim?.key !== "npc-typing") l.spr.play("npc-typing", true);
    this.clearEmote(l);
  } else if (state === "idle") {
    if (l.spr.anims.currentAnim?.key !== "npc-idle-a") l.spr.play("npc-idle-a", true);
    this.clearEmote(l);
  } else if (state === "blocked") {
    l.spr.play("npc-idle-a", true);
    this.showEmote(l, /*alert frame*/ 3);   // pick the "!" frame index in emotes sheet
  }
}

private showEmote(l: Live, frame: number): void {
  if (!l.emote) {
    l.emote = this.scene.add.sprite(l.spr.x, l.spr.y - 22, "emotes", frame)
      .setDepth(DEPTH.entityBase + l.spr.y + 1);
    // bob (farm uses tweens like this everywhere)
    this.scene.tweens.add({ targets: l.emote, y: l.emote.y - 3, duration: 500,
      yoyo: true, repeat: -1, ease: "Sine.InOut" });
  }
  l.emote.setFrame(frame).setVisible(true);
}
private clearEmote(l: Live): void { l.emote?.setVisible(false); }

// keep the emote tracking the NPC each frame (call from manager.update)
update(): void {
  for (const l of this.live) {
    l.spr.setDepth(DEPTH.entityBase + l.spr.y);
    if (l.emote) l.emote.setPosition(l.spr.x, l.spr.y - 22).setDepth(DEPTH.entityBase + l.spr.y + 1);
  }
}
```

Call `npcs.setState("ada", "working")` from your external data sync (React effect → `game.events.emit("set-npc-state", {...})` → scene listener → `npcs.setState(...)`). Round-trips both ways through the same `game.events` bus.

---

## 6. `vg new` scaffold layout + `vg generate` syntax

**`vg new <slug>`** (default `--engine phaser`) runs `tiged("phaserjs/template-vite-ts")` — the official Phaser 4 + Vite + TS starter (package.json pins `phaser@^4` despite the upstream README still saying "Phaser 3"). After fetch it: rewrites `package.json` name, writes `vibedgames.json` (`{ slug, name }`), appends a Vibedgames deploy footer to README.

Commands:
```sh
vg new office                       # Phaser 4 + Vite + TS (default)
vg new office --here                # scaffold into current dir
vg new office --engine none         # minimal Vite+TS canvas (offline)
vg new office --template owner/repo  # any degit spec
```
Resulting layout (upstream `phaserjs/template-vite-ts` + vg post-processing):
```
office/
├── index.html
├── package.json          # name=office, phaser@^4
├── vibedgames.json       # { "slug": "office", "name": "office" }
├── tsconfig.json
├── vite/config.dev.mjs    # upstream build configs (.mjs)
├── vite/config.prod.mjs
├── log.js                 # upstream telemetry shim (harmless)
├── public/assets/         # drop Limezu PNGs here
└── src/
    ├── main.ts            # new Phaser.Game(config)
    └── scenes/            # Boot/Preloader/MainMenu/Game — replace with Office scenes
```
Deploy: `npm install && npm run dev`, then `npm run build && vg deploy ./dist` → `office.vibedgames.com`.

**`vg generate`** (subcommand surface; agents must pass `--json`). It's a fal model runner, not a sprite tool — use it to generate **missing** assets (a player avatar, a prop), not to slice Limezu sheets:

```sh
vg generate models "pixel art top-down character sprite" --json   # discover endpoint
vg generate schema fal-ai/flux/dev --json                          # confirm field names
vg generate run fal-ai/flux/dev \
  --prompt "16x16 top-down office worker walk cycle, 4 frames, transparent bg, pixel art" \
  --download "./public/assets/char/{request_id}_{index}.{ext}" \
  --json
# async (video/3d): submit then poll
SUBMIT=$(vg generate run <endpoint> --prompt "..." --async --json)
REQ=$(echo "$SUBMIT" | jq -r '.request_id')
vg generate status <endpoint> "$REQ" --download "./public/assets/{request_id}.{ext}" --json
```
Subcommands: `run`, `status`, `models`, `schema`, `pricing`, `docs`, `upload`. Rule from the skill: never invent endpoint IDs — `models` to discover, `schema` to verify, then `run`.

For **slicing the raw Limezu sheets** (not generation), there's a separate `asset-pipeline` skill with `scripts/` to probe sheets for non-empty 16×16 grid frames and emit frame/size metadata — use that to figure out frame indices, then load with `load.spritesheet`.

---

## 7. Frame config conventions for 16×16 Limezu-style sheets

Limezu "Modern Office" (Serene Village family) is **16px-native**. Critical: characters are **not square** — they're 16 wide × 32 tall (a head+body occupying two stacked tiles). Tiles and most props are 16×16.

```ts
// Tiles / props (16x16 grid, no margin/spacing in Limezu packs)
this.load.spritesheet("office-tiles", "assets/tiles/office.png", { frameWidth: 16, frameHeight: 16 });
this.load.image("desk", "assets/props/desk.png");                  // singles via load.image

// Characters — 16 wide, 32 tall (TALLER than the tile)
this.load.spritesheet("p-down", "assets/char/down.png", { frameWidth: 16, frameHeight: 32 });

// UI emotes — 16x16
this.load.spritesheet("emotes", "assets/ui/emotes.png", { frameWidth: 16, frameHeight: 16 });
```

Conventions (from the SKILL spritesheet ref + farm/bomberman):
- **Measure, never guess.** Verify: `imageWidth = frameWidth*cols + spacing*(cols-1) + margin*2`. Limezu packs are usually `margin:0, spacing:0`, so `cols = imageWidth/16`.
- **`generateFrameNumbers(sheet, {})`** (empty config) uses the whole sheet in order — farm relies on this so frame *count* lives in the sheet, not the code (`mk("p-walk", "p-walk", 12, -1)`).
- **Char origin** should be bottom-ish, not center: farm uses `setOrigin(0.5, 0.82)`, bomberman effectively bottom-anchors. For 16×32 Limezu chars use `setOrigin(0.5, 0.9)` so the feet sit on the tile and y-sort/depth math (`DEPTH.entityBase + sprite.y`) puts them correctly behind/in front of desks.
- **Set `pixelArt: true` + `roundPixels: true`** in config (farm does) and `image-rendering: pixelated` in CSS, or 16px tiles shimmer at zoom 3.25.
- **Left-facing = flip the side sheet** (`setFlipX(true)`), don't author a 4th sheet — both farm and bomberman do this.

---

### My take / friction to flag
- **Biggest decision is collision.** Farm enables arcade physics in config but never uses colliders — all movement is manual AABB against `isSolidTile`. For a one-room office this is the path of least resistance and what I coded above. Don't half-adopt arcade (enabling `body.setVelocity` *and* manual resolution will fight).
- **`vg generate` won't slice Limezu.** It generates *new* art via fal. For the actual Limezu sheets, lean on the `asset-pipeline` skill's frame-probing scripts to get exact indices — guessing frame dims is the #1 silent-corruption source per the Phaser skill.
- **Press-A clash.** A is WASD-strafe in farm. For "press A to interact" either move strafe off A or use Space/E. I'd ship Space/E for interact and reserve a dedicated key — cleaner than overloading A.
- **NPCs as plain sprites (no bodies)** is correct here — farm proves you don't need physics NPCs for adjacency-based talk; it's just integer-tile distance checks, which also makes the `working/idle/blocked` external-state drive trivial.

Relevant files I read (all absolute):
- `/Users/kyh/Documents/Projects/vibedgames/games/farm/src/main.ts`, `/config.ts`, `/scenes/BootScene.ts`, `/scenes/GameScene.ts`, `/scenes/HudScene.ts`, `/world/world.ts`, `/world/mapgen.ts`, `/entities/npcs.ts`, `/data/npcs.ts`, `/index.html`, `/package.json`
- `/Users/kyh/Documents/Projects/vibedgames/games/bomberman/src/scenes/BootScene.ts`, `/scenes/GameScene.ts`, `/shared/constants.ts`, `/index.html`
- `/Users/kyh/Documents/Projects/vibedgames/plugins/game-engines/skills/phaser/SKILL.md` + `references/spritesheets-and-textures.md`, `references/tilemaps.md`
- `/Users/kyh/Documents/Projects/vibedgames/apps/cli/src/commands/new.ts`, `/commands/generate.ts`, `/README.md`
- `/Users/kyh/Documents/Projects/vibedgames/plugins/generate/skills/generate/SKILL.md`, `/plugins/asset-pipeline/skills/asset-pipeline/SKILL.md`
