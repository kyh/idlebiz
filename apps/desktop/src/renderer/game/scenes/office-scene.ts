import Phaser from "phaser";
import { TILE, WALK_SPEED, ZOOM, DEPTH, COLORS } from "@/renderer/game/config";
import {
  loadCharacter,
  ensureWalkAnims,
  idleFrame,
  characterDepth,
  CHAR_ORIGIN_X,
  CHAR_ORIGIN_Y,
  BUST,
  type Dir,
} from "@/renderer/game/characters";
import {
  NpcManager,
  type NpcState,
  type Seat,
  type PathProvider,
  type Poi,
} from "@/renderer/game/npcs";
import {
  OFFICE_CELL,
  OFFICE_COLS,
  OFFICE_H,
  OFFICE_OBJECT_PLACEMENTS,
  OFFICE_ROWS,
  OFFICE_SOLID_GRID,
  OFFICE_SPAWN,
  OFFICE_W,
  OFFICE_WORK_SEATS,
  officeSolidAt,
  type PixelPoint,
} from "@/renderer/game/office-layout";
import type { ActivityEvent, Employee } from "@/shared/domain";

const FACING_OFFSET: Record<Dir, { x: number; y: number }> = {
  down: { x: 0, y: 1 },
  up: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const WORKSPACE_KIT_PATH = "workspace-kit";
const PATH_STEP = TILE / 2;
const BODY_HALF_WIDTH = 8;
const BODY_HALF_HEIGHT = 6;

/** How far above their workstation a seated employee is lifted (see seatDepth). */
const SEAT_LIFT = 0.25;

/** Opaque-pixel coverage of a room texture, in texture space. */
interface OpaqueMask {
  readonly opaque: Uint8Array;
  readonly w: number;
  readonly h: number;
}

// Idle-life points of interest on the current map: the water cooler and the
// printer get faced, the break-room chair gets sat on.
const OFFICE_POIS: readonly Poi[] = [
  { x: 304, y: 408, face: "up" }, // water cooler (break-room entrance)
  { x: 440, y: 168, face: "up" }, // printer cart (top right)
  { x: 240, y: 400, face: "down", sit: "left" }, // break-room office chair
  { x: 200, y: 424, face: "down" }, // the money corner
];
const PATH_SEARCH_RADIUS = 6;

const CARDINAL_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
];

interface PathTile {
  readonly tx: number;
  readonly ty: number;
}

interface PathTarget {
  readonly tile: PathTile;
  readonly point: PixelPoint;
}

function parseTileKey(tileKey: string): PathTile {
  const comma = tileKey.indexOf(",");
  return {
    tx: Number(tileKey.slice(0, comma)),
    ty: Number(tileKey.slice(comma + 1)),
  };
}

function samePoint(a: PixelPoint, b: PixelPoint): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < 1;
}

/** Tiled office assembled from Modern Office object sprites. */
export class OfficeScene extends Phaser.Scene {
  private player?: Phaser.GameObjects.Sprite;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys?: Record<string, Phaser.Input.Keyboard.Key>;
  private facing: Dir = "down";
  private founderSeed = "founder-player-001";
  private playerKey = "player";
  private debugGfx?: Phaser.GameObjects.Graphics;
  private pathCols = Math.ceil(OFFICE_W / PATH_STEP);
  private pathRows = Math.ceil(OFFICE_H / PATH_STEP);
  private npcs?: NpcManager;
  private activityUnsub?: () => void;
  private masks = new Map<string, OpaqueMask>();

  constructor() {
    super("office");
  }

  private key(tx: number, ty: number): string {
    return `${tx},${ty}`;
  }

  private solidAtPx(x: number, y: number): boolean {
    return officeSolidAt(x, y);
  }

  private bodyBlockedAt(x: number, y: number): boolean {
    return (
      this.solidAtPx(x - BODY_HALF_WIDTH, y - BODY_HALF_HEIGHT) ||
      this.solidAtPx(x + BODY_HALF_WIDTH, y - BODY_HALF_HEIGHT) ||
      this.solidAtPx(x - BODY_HALF_WIDTH, y + BODY_HALF_HEIGHT) ||
      this.solidAtPx(x + BODY_HALF_WIDTH, y + BODY_HALF_HEIGHT)
    );
  }

  preload() {
    const loaded = new Set<string>();
    for (const placement of OFFICE_OBJECT_PLACEMENTS) {
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

    void this.boot();
    this.exposeDebug();

    const onSpawn = (emp: Employee) => void this.npcs?.spawn(emp);
    const onDespawn = (employeeId: string) => this.npcs?.despawn(employeeId);
    const onModal = (open: boolean) => {
      if (this.input.keyboard) this.input.keyboard.enabled = !open;
    };
    const onCompanyReady = () => this.scene.restart();
    this.game.events.on("spawn-employee", onSpawn);
    this.game.events.on("despawn-employee", onDespawn);
    this.game.events.on("ui-modal", onModal);
    this.game.events.on("company-ready", onCompanyReady);
    this.subscribeActivity();

    void Reflect.set(window, "__game", this.game);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.activityUnsub?.();
      this.game.events.off("spawn-employee", onSpawn);
      this.game.events.off("despawn-employee", onDespawn);
      this.game.events.off("ui-modal", onModal);
      this.game.events.off("company-ready", onCompanyReady);
      this.npcs?.destroy();
      this.debugGfx?.destroy();
      this.debugGfx = undefined;
      this.npcs = undefined;
      this.player = undefined;
      Reflect.deleteProperty(window, "__officeDebug");
    });
  }

  private async boot(): Promise<void> {
    const seats = this.buildRoom();

    const cam = this.cameras.main;
    cam.removeBounds();
    cam.setZoom(ZOOM);
    cam.setRoundPixels(true);
    this.centerCameraOn(OFFICE_SPAWN);

    this.npcs = new NpcManager(this, seats, this.makePathProvider(), OFFICE_POIS);

    const bridge = window.appBridge;
    const company = bridge ? await bridge.getCompany() : null;
    const employees =
      company && bridge ? await bridge.listEmployees({ companyId: company.id }) : [];
    this.founderSeed = company?.founderSpriteSeed ?? "founder-player-001";

    await this.spawnPlayer(OFFICE_SPAWN);
    for (const emp of employees) await this.npcs.spawn(emp);

    if (company && bridge) {
      const tasks = await bridge.listTasks({ companyId: company.id });
      for (const t of tasks) {
        if (t.status === "blocked" && t.assigneeId && t.blocked)
          this.npcs.setState(t.assigneeId, "blocked");
      }
    }

    this.game.events.emit("office-ready");
  }

  private buildRoom(): Seat[] {
    const room = OFFICE_OBJECT_PLACEMENTS.map((placement) =>
      this.add
        .image(placement.x, placement.y, placement.key)
        .setOrigin(0, 0)
        .setDepth(placement.depth)
        .setFlip(placement.flipX, placement.flipY),
    );
    return OFFICE_WORK_SEATS.map((seat) => ({
      x: seat.x,
      y: seat.y,
      depth: this.seatDepth(seat, room),
    }));
  }

  /**
   * Depth a seated employee renders at.
   *
   * The art pack paints its seated workers OVER the workstation — chair back behind the
   * head, desk in front — and pure y-sorting cannot express that: a chair's floor contact
   * is always SOUTH of whoever sits in it, so y-sort buries the sitter behind the chair
   * (it hid 92-97% of every employee). Lift the occupant just above the topmost thing
   * their bust actually overlaps and no further, so a colleague walking past the front of
   * the desk still occludes them.
   */
  private seatDepth(seat: PixelPoint, room: readonly Phaser.GameObjects.Image[]): number {
    let depth = characterDepth(seat.y);
    for (const image of room) {
      // overhead props are meant to stay above actors; never lift past them
      if (image.depth <= depth || image.depth >= DEPTH.overhead) continue;
      if (!this.bustOverlaps(seat, image)) continue;
      depth = image.depth;
    }
    return depth + SEAT_LIFT;
  }

  /**
   * Does a seated bust at `seat` touch any opaque pixel of `image`?
   *
   * Walks the overlap rect in whole pixels: the mask is indexed arithmetically, and a
   * fractional or out-of-range index reads past the array as `undefined` — falsy, so a
   * miss. TS types a Uint8Array read as `number`, so nothing would flag that; keep every
   * index an integer inside the mask instead of trusting placements to stay aligned.
   */
  private bustOverlaps(seat: PixelPoint, image: Phaser.GameObjects.Image): boolean {
    const mask = this.opaqueMask(image.texture.key);
    if (!mask) return true; // unreadable source: assume it covers, so the seat clears it
    const x0 = Math.floor(Math.max(seat.x - BUST.halfWidth, image.x));
    const x1 = Math.ceil(Math.min(seat.x + BUST.halfWidth, image.x + mask.w));
    const y0 = Math.floor(Math.max(seat.y - BUST.height, image.y));
    const y1 = Math.ceil(Math.min(seat.y, image.y + mask.h));
    if (x1 <= x0 || y1 <= y0) return false;
    for (let y = y0; y < y1; y++) {
      const dy = Math.floor(y - image.y);
      const ly = image.flipY ? mask.h - 1 - dy : dy;
      if (ly < 0 || ly >= mask.h) continue;
      for (let x = x0; x < x1; x++) {
        const dx = Math.floor(x - image.x);
        const lx = image.flipX ? mask.w - 1 - dx : dx;
        if (lx < 0 || lx >= mask.w) continue;
        if (mask.opaque[ly * mask.w + lx]) return true;
      }
    }
    return false;
  }

  /**
   * Opaque coverage of a room texture, cached. Object canvases are heavily padded, so
   * bounds-only hit-testing would lift a seat above furniture it never actually touches.
   * Only textures whose bounds reach a seat are ever read back.
   */
  private opaqueMask(key: string): OpaqueMask | null {
    const cached = this.masks.get(key);
    if (cached) return cached;
    const source = this.textures.get(key).getSourceImage();
    if (!(source instanceof HTMLImageElement) && !(source instanceof HTMLCanvasElement))
      return null;
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const opaque = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < opaque.length; i++) opaque[i] = pixels[i * 4 + 3] > 0 ? 1 : 0;
    const mask: OpaqueMask = { opaque, w: canvas.width, h: canvas.height };
    this.masks.set(key, mask);
    return mask;
  }

  /** Toggle (G) a red overlay of the authored collision grid for debugging. */
  private toggleCollisionOverlay(): void {
    if (this.debugGfx) {
      this.debugGfx.destroy();
      this.debugGfx = undefined;
      return;
    }
    const gfx = this.add.graphics().setDepth(DEPTH.emote - 1);
    gfx.fillStyle(0xff3366, 0.35);
    for (let r = 0; r < OFFICE_ROWS; r++) {
      for (let c = 0; c < OFFICE_COLS; c++) {
        if (OFFICE_SOLID_GRID[r]?.[c])
          gfx.fillRect(c * OFFICE_CELL, r * OFFICE_CELL, OFFICE_CELL, OFFICE_CELL);
      }
    }
    this.debugGfx = gfx;
  }

  private exposeDebug(): void {
    const api = {
      bodyBlockedAt: (x: number, y: number) => this.bodyBlockedAt(x, y),
      solidAtPx: (x: number, y: number) => this.solidAtPx(x, y),
      snapshot: () => ({
        camera: {
          x: this.cameras.main.scrollX,
          y: this.cameras.main.scrollY,
          zoom: this.cameras.main.zoom,
        },
        objects: OFFICE_OBJECT_PLACEMENTS.length,
        player: {
          x: this.player?.x ?? null,
          y: this.player?.y ?? null,
        },
        seats: OFFICE_WORK_SEATS.length,
        world: {
          h: OFFICE_H,
          w: OFFICE_W,
        },
      }),
      probeMove: (start: PixelPoint, delta: PixelPoint) => this.probeMove(start, delta),
    };
    void Reflect.set(window, "__officeDebug", api);
  }

  private probeMove(start: PixelPoint, delta: PixelPoint) {
    const player = this.player;
    if (!player) return null;
    const original = { x: player.x, y: player.y };
    player.setPosition(start.x, start.y);
    this.moveResolved(delta.x, delta.y);
    const result = { x: player.x, y: player.y };
    player.setPosition(original.x, original.y);
    return result;
  }

  /** BFS over a half-tile grid; collision itself uses the authored grid. */
  private makePathProvider(): PathProvider {
    const nodePx = (gx: number, gy: number): { x: number; y: number } => ({
      x: gx * PATH_STEP + PATH_STEP / 2,
      y: gy * PATH_STEP + PATH_STEP / 2,
    });
    const walkable = (gx: number, gy: number): boolean => {
      if (gx < 0 || gy < 0 || gx >= this.pathCols || gy >= this.pathRows) return false;
      const pt = nodePx(gx, gy);
      return !this.bodyBlockedAt(pt.x, pt.y);
    };
    const nearestWalkable = (tx: number, ty: number): PathTile | null => {
      if (walkable(tx, ty)) return { tx, ty };
      for (let radius = 1; radius <= PATH_SEARCH_RADIUS; radius += 1) {
        for (let oy = -radius; oy <= radius; oy += 1) {
          for (let ox = -radius; ox <= radius; ox += 1) {
            if (Math.abs(ox) !== radius && Math.abs(oy) !== radius) continue;
            const nx = tx + ox;
            const ny = ty + oy;
            if (walkable(nx, ny)) return { tx: nx, ty: ny };
          }
        }
      }
      return null;
    };
    const toTile = (px: number, py: number): PathTile | null => {
      const tx = Math.floor(px / PATH_STEP);
      const ty = Math.floor(py / PATH_STEP);
      return nearestWalkable(tx, ty);
    };
    const toTarget = (px: number, py: number): PathTarget | null => {
      const tile = toTile(px, py);
      if (!tile) return null;
      const exactPoint = { x: px, y: py };
      return {
        tile,
        point: this.bodyBlockedAt(px, py) ? nodePx(tile.tx, tile.ty) : exactPoint,
      };
    };
    return {
      findPath: (fromX, fromY, toX, toY) => {
        const start = toTile(fromX, fromY);
        const goal = toTarget(toX, toY);
        if (!start || !goal) return null;
        const startKey = this.key(start.tx, start.ty);
        const goalKey = this.key(goal.tile.tx, goal.tile.ty);
        const parent = new Map<string, string | null>([[startKey, null]]);
        const queue: Array<{ tx: number; ty: number }> = [start];
        let cursor = 0;
        let found = startKey === goalKey;
        while (cursor < queue.length && !found) {
          const cur = queue[cursor];
          cursor += 1;
          if (!cur) break;
          for (const [dx, dy] of CARDINAL_STEPS) {
            const nx = cur.tx + dx;
            const ny = cur.ty + dy;
            const nk = this.key(nx, ny);
            if (!walkable(nx, ny) || parent.has(nk)) continue;
            parent.set(nk, this.key(cur.tx, cur.ty));
            if (nk === goalKey) {
              found = true;
              break;
            }
            queue.push({ tx: nx, ty: ny });
          }
        }
        if (!found) return null;
        const tiles: string[] = [];
        let parentCursor: string | null = goalKey;
        while (parentCursor) {
          tiles.unshift(parentCursor);
          parentCursor = parent.get(parentCursor) ?? null;
        }
        const pts = tiles.map((tileKey) => {
          const tile = parseTileKey(tileKey);
          return nodePx(tile.tx, tile.ty);
        });
        pts.shift();
        const last = pts[pts.length - 1];
        if (!last || !samePoint(last, goal.point)) pts.push(goal.point);
        return pts;
      },
      nearestFloor: (x, y) => {
        const tile = toTile(x, y);
        if (!tile) return null;
        return nodePx(tile.tx, tile.ty);
      },
      randomFloor: (x, y, radius) => {
        for (let i = 0; i < 24; i++) {
          const tx = Math.floor((x + (Math.random() * 2 - 1) * radius) / PATH_STEP);
          const ty = Math.floor((y + (Math.random() * 2 - 1) * radius) / PATH_STEP);
          if (walkable(tx, ty)) return nodePx(tx, ty);
        }
        return null;
      },
    };
  }

  private subscribeActivity(): void {
    const bridge = window.appBridge;
    if (!bridge) return;
    this.activityUnsub = bridge.onActivity((e: ActivityEvent) => {
      if (!e.employeeId) return;
      if (e.kind === "chat" && typeof e.message === "string") {
        const m = /^→ ([^(]+) \(/.exec(e.message);
        this.npcs?.onChat(e.employeeId, e.message, m?.[1]?.trim() ?? null);
        return;
      }
      if (e.kind !== "status" || typeof e.message !== "string") return;
      const map: Record<string, NpcState | undefined> = {
        running: "working",
        done: "idle",
        failed: "idle",
        cancelled: "idle",
        blocked: "blocked",
      };
      const next = map[e.message];
      if (next) this.npcs?.setState(e.employeeId, next);
    });
  }

  private tryAction(): void {
    const player = this.player;
    if (!player || !this.npcs) return;
    const off = FACING_OFFSET[this.facing];
    const id = this.npcs.interactAt(player.x + off.x * 26, player.y + off.y * 26);
    if (id) this.game.events.emit("npc-interact", { employeeId: id });
  }

  private async spawnPlayer(spawn: { x: number; y: number }): Promise<void> {
    const key = `player-${this.founderSeed}`;
    await loadCharacter(this, key, this.founderSeed);
    ensureWalkAnims(this, key);
    this.playerKey = key;
    const player = this.add
      .sprite(spawn.x, spawn.y, key, idleFrame("down"))
      .setOrigin(CHAR_ORIGIN_X, CHAR_ORIGIN_Y);
    player.setDepth(characterDepth(player.y));
    this.player = player;
    this.centerCameraOn(player);
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
      if (dx !== 0) this.facing = dx < 0 ? "left" : "right";
      else this.facing = dy < 0 ? "up" : "down";
      const len = Math.hypot(dx, dy) || 1;
      this.moveResolved((dx / len) * WALK_SPEED * dt, (dy / len) * WALK_SPEED * dt);
      player.play(`${this.playerKey}-walk-${this.facing}`, true);
    } else {
      player.anims.stop();
      player.setFrame(idleFrame(this.facing));
    }
    player.setDepth(characterDepth(player.y));
    this.centerCameraOn(player);
    this.npcs?.update();
  }

  private moveResolved(mx: number, my: number): void {
    const player = this.player;
    if (!player) return;
    const nx = player.x + mx;
    if (!this.bodyBlockedAt(nx, player.y)) player.x = nx;
    const ny = player.y + my;
    if (!this.bodyBlockedAt(player.x, ny)) player.y = ny;
  }

  /** Keep the player dead-centre always (no clamping to the room edges). */
  private centerCameraOn(point: PixelPoint): void {
    this.cameras.main.centerOn(point.x, point.y);
  }
}
