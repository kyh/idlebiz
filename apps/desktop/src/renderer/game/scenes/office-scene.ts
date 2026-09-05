import Phaser from "phaser";
import { bridge } from "@/renderer/bridge";
import {
  characterAnims,
  characterDepth,
  CHAR_ORIGIN_X,
  CHAR_ORIGIN_Y,
  idleFrame,
  type CharacterAnims,
  type Dir,
} from "@/renderer/game/character-sheet";
import { loadCharacter } from "@/renderer/game/characters";
import { ClickWalk, type Walker } from "@/renderer/game/click-walk";
import { WALK_SPEED, ZOOM, DEPTH, COLORS } from "@/renderer/game/config";
import { facingToward } from "@/renderer/game/movement";
import { NpcManager, type NpcState, type Seat, type Poi } from "@/renderer/game/npcs";
import {
  BUNDLED_LAYOUT,
  officeOf,
  type Office,
  type OfficeLayoutData,
  type PixelPoint,
} from "@/renderer/game/office-layout";
import { poseForToolKind } from "@/renderer/game/office-poses";
import { seatDepthOracle } from "@/renderer/game/seat-depth";
import { frameMask, textureMasks, type OpaqueMask } from "@/renderer/game/texture-masks";
import { FRAME_H, FRAME_W } from "@/shared/character-frame";
import { hiddenNodes, type PaintedSprite } from "@/shared/office-sight";
import type { ActivityEvent } from "@/shared/activity";
import { DEFAULT_FOUNDER_SEED, employeeStatusOf, type Employee } from "@/shared/domain";
import { bodyBlockedAt, solidAt, withoutNodes, type WalkGrid } from "@/shared/office-grid";

const FACING_OFFSET = {
  down: { x: 0, y: 1 },
  up: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
} satisfies Record<Dir, { x: number; y: number }>;

const WORKSPACE_KIT_PATH = "workspace-kit";

/** The founder on screen: their sprite and the anims cut from its sheet. */
interface Player {
  readonly sprite: Phaser.GameObjects.Sprite;
  readonly anims: CharacterAnims;
}

/** Probes into the live office for CDP-driven checks (`window.__officeDebug`). */
export interface OfficeDebugApi {
  bodyBlockedAt(x: number, y: number): boolean;
  solidAtPx(x: number, y: number): boolean;
  snapshot(): {
    camera: { x: number; y: number; zoom: number };
    objects: number;
    player: { x: number | null; y: number | null };
    door: PixelPoint;
    seats: number;
    world: { h: number; w: number };
  };
  /** Where a body starting at `start` ends up after trying to move by `delta`. */
  probeMove(start: PixelPoint, delta: PixelPoint): PixelPoint | null;
}

declare global {
  interface Window {
    __officeDebug?: OfficeDebugApi;
  }
}

/** Tiled office assembled from Modern Office object sprites. */
const roundQuad = (obj: Phaser.GameObjects.GameObject): void => {
  obj.vertexRoundMode = "fullAuto";
};

/** What the scene is started with: the layout it builds the room from. */
export interface OfficeSceneData {
  layout: OfficeLayoutData;
}
export const officeSceneData = (layout: OfficeLayoutData): OfficeSceneData => ({ layout });

export class OfficeScene extends Phaser.Scene {
  private player?: Player;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys?: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;
  private facing: Dir = "down";
  private debugGfx?: Phaser.GameObjects.Graphics;
  private npcs?: NpcManager;
  private clickWalk?: ClickWalk;
  /** The layout's grid with the spots nobody should stand in closed; set once the room is judged. */
  /**
   * The layout in force, from the scene data every start and restart carries.
   * Phaser constructs the scene before any data exists, so the bundled office
   * stands in until init() runs — which is before preload reads anything.
   */
  private office: Office = officeOf(BUNDLED_LAYOUT);
  private grid: WalkGrid = this.office.grid;
  private modalOpen = false;
  /** Bumped by every create(): an await in boot() that outlives its scene must not touch the next one. */
  private generation = 0;
  private activityUnsub?: () => void;

  constructor() {
    super("office");
  }

  init(data: OfficeSceneData) {
    this.office = officeOf(data.layout);
    this.grid = this.office.grid;
  }

  preload() {
    const loaded = new Set<string>();
    for (const placement of this.office.placements) {
      if (loaded.has(placement.key)) continue;
      loaded.add(placement.key);
      this.load.image(placement.key, placement.path);
    }
    this.load.spritesheet("emotes", `${WORKSPACE_KIT_PATH}/emotes.png`, {
      frameWidth: 32,
      frameHeight: 32,
    });
  }

  create() {
    this.cameras.main.setBackgroundColor(COLORS.bg);
    // roundPixels alone rounds nothing here: the default vertexRoundMode trusts
    // only an unzoomed camera, and this one is zoomed ZOOMx. An integer zoom keeps
    // every corner on the same fraction, so rounding whole quads is safe and is
    // what keeps a walking sprite off the half pixel.
    this.events.on(Phaser.Scenes.Events.ADDED_TO_SCENE, roundQuad);
    const kb = this.input.keyboard;
    if (!kb) throw new Error("keyboard input unavailable");
    this.cursors = kb.createCursorKeys();
    this.keys = {
      W: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE).on("down", () => this.tryAction());
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.E).on("down", () => this.tryAction());
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.G).on("down", () => this.toggleCollisionOverlay());

    // Click to go there. The HUD sits over this canvas but is pointer-events-none except
    // on its own controls, so a click on a button never reaches us.
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      if (!this.modalOpen) this.clickWalk?.onPointerDown({ x: p.worldX, y: p.worldY });
    });

    void this.boot();
    // the handle names are the CDP contract in AGENTS.md, dangling underscores and all
    window.__officeDebug = this.debugApi();

    // live hires and releases come and go through the door
    const onSpawn = (emp: Employee) => void this.npcs?.spawn(emp, "door");
    const onDespawn = (employeeId: string) => this.npcs?.despawn(employeeId, "door");
    const onModal = (open: boolean) => {
      this.modalOpen = open;
      if (open) this.clickWalk?.cancel();
      this.claimKeyboard();
    };
    const onCompanyReady = () => this.scene.restart();
    this.game.events.on("spawn-employee", onSpawn);
    this.game.events.on("despawn-employee", onDespawn);
    this.game.events.on("ui-modal", onModal);
    this.game.events.on("company-ready", onCompanyReady);
    // Phaser captures its keys on window and cancels their default whoever has
    // focus — a space typed into the team room would never land. The keyboard
    // is the game's only while no text field is being typed into.
    const onFocusChange = () => this.claimKeyboard();
    document.addEventListener("focusin", onFocusChange);
    document.addEventListener("focusout", onFocusChange);
    this.claimKeyboard();
    this.subscribeActivity();

    window.__game = this.game;
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.events.off(Phaser.Scenes.Events.ADDED_TO_SCENE, roundQuad);
      this.activityUnsub?.();
      document.removeEventListener("focusin", onFocusChange);
      document.removeEventListener("focusout", onFocusChange);
      this.game.events.off("spawn-employee", onSpawn);
      this.game.events.off("despawn-employee", onDespawn);
      this.game.events.off("ui-modal", onModal);
      this.game.events.off("company-ready", onCompanyReady);
      this.npcs?.destroy();
      this.debugGfx?.destroy();
      this.debugGfx = undefined;
      this.clickWalk?.cancel();
      this.clickWalk = undefined;
      this.npcs = undefined;
      this.player = undefined;
      delete window.__officeDebug;
    });
  }

  /** The game owns the keys when nothing else is typing and no panel is up. */
  private claimKeyboard(): void {
    const kb = this.input.keyboard;
    if (!kb) return;
    const el = document.activeElement;
    const typing =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable);
    const ours = !this.modalOpen && !typing;
    kb.enabled = ours;
    if (ours) kb.enableGlobalCapture();
    else kb.disableGlobalCapture();
  }

  private async boot(): Promise<void> {
    const generation = ++this.generation;
    const masks = textureMasks(this.textures);
    const seats = this.buildRoom(masks);

    const cam = this.cameras.main;
    cam.removeBounds();
    cam.setZoom(ZOOM);
    cam.setRoundPixels(true);
    this.centerCameraOn(this.office.spawn);

    const company = await bridge().getCompany();
    if (generation !== this.generation) return;
    // the founder and the roster are independent fetches; the colleagues wait on both,
    // because Phaser's loader is single-batch and the founder's sheet must land first
    const [player, employees, blocked] = await Promise.all([
      this.spawnPlayer(company ? company.founderSpriteSeed : DEFAULT_FOUNDER_SEED),
      company ? bridge().listEmployees({ companyId: company.id }) : [],
      company ? bridge().listTasks({ companyId: company.id, status: ["blocked"] }) : [],
    ]);
    if (generation !== this.generation) return;
    const grid = this.sightSealed(masks, player);
    this.grid = grid;
    const npcs = new NpcManager(this, seats, grid, this.idlePois(), this.office.door);
    this.npcs = npcs;
    this.clickWalk = new ClickWalk(this, grid, this.walkerOf(player), npcs, (id) =>
      this.talkTo(id),
    );

    // the office is already staffed when it opens: nobody parades in on boot.
    // Spawns serialise on Phaser's loader, but composing the sheets need not:
    // main caches by seed, so warming them all at once makes the chain read hits.
    await Promise.all(employees.map((emp) => bridge().composeCharacter({ seed: emp.spriteSeed })));
    if (generation !== this.generation) return;
    for (const emp of employees) await npcs.spawn(emp, "settled");
    if (generation !== this.generation) return;
    for (const task of blocked) {
      if (task.assigneeId) npcs.setState(task.assigneeId, "blocked");
    }

    this.game.events.emit("office-ready");
  }

  private buildRoom(masks: (key: string) => OpaqueMask | null): Seat[] {
    const room = this.office.placements.map((placement) =>
      this.add
        .image(placement.x, placement.y, placement.key)
        .setOrigin(0, 0)
        .setDepth(placement.depth)
        .setFlip(placement.flipX, placement.flipY),
    );
    const seatDepth = seatDepthOracle(masks);
    return this.office.seats
      .filter((seat) => seat.role === "work")
      .map((seat) => ({ x: seat.x, y: seat.y, depth: seatDepth(seat, room) }));
  }

  /**
   * The walk grid with every spot where the founder's face would be painted over
   * closed. Judged from the textures the room is actually drawn with, so it holds
   * for a saved office the bundled gate never saw.
   */
  private sightSealed(masks: (key: string) => OpaqueMask | null, player: Player): WalkGrid {
    const sheet = masks(player.sprite.texture.key);
    if (!sheet) return this.office.grid;
    const silhouette = frameMask(sheet, { x: 0, y: 0, w: FRAME_W, h: FRAME_H });
    // reading a texture is a canvas round trip: only what can draw above a character
    const sprites: PaintedSprite[] = [];
    for (const placement of this.office.placements) {
      if (placement.def.layer === "floor") continue;
      const mask = masks(placement.key);
      if (mask) sprites.push({ obj: placement.def, mask });
    }
    const hidden = hiddenNodes(this.office.grid, this.office.spawn, sprites, silhouette);
    return withoutNodes(
      this.office.grid,
      this.office.spawn,
      hidden.map((h) => h.node),
    );
  }

  /** Idle-life spots from the layout: the POIs get faced, the rest seats get sat on. */
  private idlePois(): Poi[] {
    const spots: Poi[] = this.office.pois.map((p) => ({ x: p.x, y: p.y, face: p.face }));
    for (const seat of this.office.seats) {
      if (seat.role === "rest") spots.push({ x: seat.x, y: seat.y, face: "down", sit: seat.sit });
    }
    return spots;
  }

  /** Toggle (G) a red overlay of the authored collision grid for debugging. */
  private toggleCollisionOverlay(): void {
    if (this.debugGfx) {
      this.debugGfx.destroy();
      this.debugGfx = undefined;
      return;
    }
    const grid = this.grid;
    const gfx = this.add.graphics().setDepth(DEPTH.emote - 1);
    gfx.fillStyle(0xff3366, 0.35);
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        if (grid.solid[r]?.[c]) gfx.fillRect(c * grid.cell, r * grid.cell, grid.cell, grid.cell);
      }
    }
    this.debugGfx = gfx;
  }

  private debugApi(): OfficeDebugApi {
    return {
      bodyBlockedAt: (x, y) => bodyBlockedAt(this.grid, x, y),
      solidAtPx: (x, y) => solidAt(this.grid, x, y),
      snapshot: () => ({
        camera: {
          x: this.cameras.main.scrollX,
          y: this.cameras.main.scrollY,
          zoom: this.cameras.main.zoom,
        },
        objects: this.office.placements.length,
        player: {
          x: this.player?.sprite.x ?? null,
          y: this.player?.sprite.y ?? null,
        },
        door: this.office.door,
        seats: this.office.seats.filter((seat) => seat.role === "work").length,
        world: {
          h: this.office.grid.height,
          w: this.office.grid.width,
        },
      }),
      probeMove: (start, delta) => this.probeMove(start, delta),
    };
  }

  private probeMove(start: PixelPoint, delta: PixelPoint): PixelPoint | null {
    const player = this.player;
    if (!player) return null;
    const { sprite } = player;
    const original = { x: sprite.x, y: sprite.y };
    sprite.setPosition(start.x, start.y);
    this.moveResolved(delta.x, delta.y);
    const result = { x: sprite.x, y: sprite.y };
    sprite.setPosition(original.x, original.y);
    return result;
  }

  private subscribeActivity(): void {
    this.activityUnsub = bridge().onActivity((e: ActivityEvent) => {
      const employeeId = e.employeeId;
      if (!employeeId) return;
      switch (e.kind) {
        case "chat":
          this.npcs?.onChat(employeeId, e.message, e.payload.to);
          return;
        // what they are doing right now, as the sprite can show it
        case "tool_call":
          this.npcs?.onTool(employeeId, poseForToolKind(e.payload.kind));
          return;
        // an ask raised mid-run: the "!" goes up now, not when the run settles
        case "run.ask":
          this.npcs?.onAsk(employeeId);
          return;
        case "status": {
          const next: NpcState = e.message === "blocked" ? "blocked" : employeeStatusOf(e.message);
          this.npcs?.setState(employeeId, next);
          return;
        }
        default:
          return;
      }
    });
  }

  private talkTo(employeeId: string): void {
    this.game.events.emit("npc-interact", { employeeId });
  }

  /** SPACE / E: talk to whoever is right in front of the founder. */
  private tryAction(): void {
    const player = this.player;
    const npcs = this.npcs;
    if (!player || !npcs) return;
    const off = FACING_OFFSET[this.facing];
    const id = npcs.interactAt(player.sprite.x + off.x * 26, player.sprite.y + off.y * 26);
    if (id) this.talkTo(id);
  }

  /** The founder as click-to-walk drives them: position from the sprite, moves through collision. */
  private walkerOf(player: Player): Walker {
    return {
      position: player.sprite,
      place: (at) => player.sprite.setPosition(at.x, at.y),
      move: (dx, dy) => this.moveResolved(dx, dy),
      face: (dir) => this.face(dir),
      walk: (dir) => this.walk(dir),
    };
  }

  private async spawnPlayer(seed: string): Promise<Player> {
    const key = `player-${seed}`;
    await loadCharacter(this, key, seed);
    const sprite = this.add
      .sprite(this.office.spawn.x, this.office.spawn.y, key, idleFrame("down"))
      .setOrigin(CHAR_ORIGIN_X, CHAR_ORIGIN_Y);
    sprite.setDepth(characterDepth(sprite.y));
    const player = { sprite, anims: characterAnims(key) };
    this.player = player;
    this.centerCameraOn(sprite);
    return player;
  }

  override update(_t: number, dms: number): void {
    const player = this.player;
    const keys = this.keys;
    const cursors = this.cursors;
    if (!player || !keys || !cursors) return;
    const dt = Math.min(dms, 50) / 1000;
    let dx = 0;
    let dy = 0;
    if (keys.A.isDown || cursors.left.isDown) dx -= 1;
    if (keys.D.isDown || cursors.right.isDown) dx += 1;
    if (keys.W.isDown || cursors.up.isDown) dy -= 1;
    if (keys.S.isDown || cursors.down.isDown) dy += 1;

    if (dx !== 0 || dy !== 0) {
      this.clickWalk?.cancel(); // taking the keys back cancels wherever the click was sending us
      const len = Math.hypot(dx, dy);
      this.moveResolved((dx / len) * WALK_SPEED * dt, (dy / len) * WALK_SPEED * dt);
      this.walk(facingToward(dx, dy));
    } else if (!this.clickWalk?.update(dt)) {
      this.stand();
    }
    const depth = characterDepth(player.sprite.y);
    if (player.sprite.depth !== depth) player.sprite.setDepth(depth);
    this.centerCameraOn(player.sprite);
    this.npcs?.update();
  }

  private walk(dir: Dir): void {
    this.facing = dir;
    const player = this.player;
    if (player) player.sprite.play(player.anims.walk[dir], true);
  }

  private face(dir: Dir): void {
    this.facing = dir;
    const sprite = this.player?.sprite;
    if (!sprite) return;
    sprite.anims.stop();
    sprite.setFrame(idleFrame(dir));
  }

  /** Come to rest on the standing frame — once, when the walk cycle is still going. */
  private stand(): void {
    if (this.player?.sprite.anims.isPlaying) this.face(this.facing);
  }

  private moveResolved(mx: number, my: number): void {
    const sprite = this.player?.sprite;
    if (!sprite) return;
    const grid = this.grid;
    const nx = sprite.x + mx;
    if (!bodyBlockedAt(grid, nx, sprite.y)) sprite.x = nx;
    const ny = sprite.y + my;
    if (!bodyBlockedAt(grid, sprite.x, ny)) sprite.y = ny;
  }

  /** Keep the player dead-centre always (no clamping to the room edges). */
  private centerCameraOn(point: PixelPoint): void {
    this.cameras.main.centerOn(point.x, point.y);
  }
}
