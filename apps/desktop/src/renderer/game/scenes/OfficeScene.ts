import Phaser from "phaser";
import { TILE, WALK_SPEED, ZOOM, DEPTH, COLORS, TIERS, tierIndexForHeadcount, type OfficeTier, type FloorKind } from "@/renderer/game/config";
import { loadCharacter, ensureWalkAnims, idleFrame, type Dir } from "@/renderer/game/characters";
import { NpcManager, type NpcState, type Seat, type PathProvider } from "@/renderer/game/npcs";
import type { ActivityEvent, Employee } from "@/shared/domain";

const FACING_OFFSET: Record<Dir, { x: number; y: number }> = {
  down: { x: 0, y: 1 },
  up: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const FLOOR_KEY: Record<FloorKind, string> = { carpet: "floor_carpet", tile: "floor_tile", wood: "floor_wood" };
const PROPS = [
  "desk", "monitor", "chair", "plant_tall",
  "floor_carpet", "floor_tile", "floor_wood",
  "tv", "board_chart", "board_pie", "teamphoto", "cert", "art_a", "art_b",
  "shelf_books", "watercooler", "vending", "printer",
] as const;

// wall palette (matches the Limezu Office_Design_2 look)
const WALL_CAP = 0x3a3f54; // dark navy top edge / exterior walls
const WALL_FACE = 0xf2f0f6; // interior wall face
const WALL_FACE_SHADE = 0xe3e0ea;
const WALL_BASE = 0xc9c5d6; // baseboard
const WALL_LINE = 0x23273a;

// Furniture geometry (px), derived from the trimmed sprite sizes.
const DESK_W = 64;
const DESK_H = 38;
const CHAIR_DROP = 30; // how far the chair sits below the desk's front edge

/**
 * Top-down office COMPOSED from individual Limezu sprites. Desks/chairs/plants
 * are real y-sorted objects: chairs have no hitbox and occlude whoever stands
 * behind them, and the room grows in tiers as the company hires.
 */
export class OfficeScene extends Phaser.Scene {
  private player?: Phaser.GameObjects.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private facing: Dir = "down";
  private founderSeed = "founder-player-001";
  private playerKey = "player";
  private tierIndex = 0;
  private solid = new Set<string>(); // "tx,ty"
  private cols = 0;
  private rows = 0;
  private npcs?: NpcManager;
  private activityUnsub?: () => void;

  constructor() {
    super("office");
  }

  private key(tx: number, ty: number): string {
    return `${tx},${ty}`;
  }
  private markSolid(tx: number, ty: number): void {
    this.solid.add(this.key(tx, ty));
  }
  private solidAtPx(x: number, y: number): boolean {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) return true;
    return this.solid.has(this.key(tx, ty));
  }

  preload() {
    for (const k of PROPS) this.load.image(k, `assets/office3/${k}.png`);
    this.load.spritesheet("emotes", "assets/office/emotes.png", { frameWidth: 32, frameHeight: 32 });
  }

  create() {
    this.cameras.main.setBackgroundColor(COLORS.bg);
    const kb = this.input.keyboard;
    if (!kb) throw new Error("keyboard input unavailable");
    this.cursors = kb.createCursorKeys();
    this.keys = kb.addKeys("W,A,S,D") as Record<string, Phaser.Input.Keyboard.Key>;
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE).on("down", () => this.tryAction());
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.E).on("down", () => this.tryAction());

    void this.boot();

    // a hire that crosses the tier threshold moves everyone into a bigger office
    const onSpawn = (emp: Employee) => {
      const headcount = (this.npcs ? this.npcs.size() : 0) + 1;
      if (tierIndexForHeadcount(headcount) !== this.tierIndex) {
        this.scene.restart();
        return;
      }
      void this.npcs?.spawn(emp);
    };
    const onModal = (open: boolean) => {
      if (this.input.keyboard) this.input.keyboard.enabled = !open;
    };
    // onboarding just finished → rebuild the room for the new team size + spawn everyone
    const onCompanyReady = () => this.scene.restart();
    this.game.events.on("spawn-employee", onSpawn);
    this.game.events.on("ui-modal", onModal);
    this.game.events.on("company-ready", onCompanyReady);
    this.subscribeActivity();

    window.__game = this.game;
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.activityUnsub?.();
      this.game.events.off("spawn-employee", onSpawn);
      this.game.events.off("ui-modal", onModal);
      this.game.events.off("company-ready", onCompanyReady);
      this.npcs?.destroy();
      this.solid.clear();
      this.npcs = undefined;
      this.player = undefined;
    });
  }

  private async boot(): Promise<void> {
    const bridge = window.appBridge;
    const company = bridge ? await bridge.getCompany() : null;
    const employees = company && bridge ? await bridge.listEmployees({ companyId: company.id }) : [];
    this.founderSeed = company?.founderSpriteSeed ?? "founder-player-001";

    this.tierIndex = tierIndexForHeadcount(employees.length);
    const tier = TIERS[this.tierIndex] ?? TIERS[0]!;
    this.cols = tier.cols;
    this.rows = tier.rows;
    const seats = this.buildRoom(tier);

    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.cols * TILE, this.rows * TILE);
    // fit the room to the viewport width (no letterbox margins); follows vertically
    const fit = this.scale.width > 0 ? this.scale.width / (this.cols * TILE) : ZOOM;
    cam.setZoom(Phaser.Math.Clamp(fit, 1.8, 3.4));
    cam.setRoundPixels(true);

    this.npcs = new NpcManager(this, seats, this.makePathProvider());

    await this.spawnPlayer(tier.spawn);
    for (const emp of employees) await this.npcs.spawn(emp);

    // restore "!" markers for questions asked before this launch
    if (company && bridge) {
      const tasks = await bridge.listTasks({ companyId: company.id });
      for (const t of tasks) {
        if (t.status === "blocked" && t.assigneeId && t.blockedQuestion) this.npcs.setState(t.assigneeId, "blocked");
      }
    }

    this.game.events.emit("office-ready");
  }

  // ---- room construction ---------------------------------------------------
  /** Build floor, walls, desks/chairs/plants. Returns the NPC seat positions. */
  private buildRoom(tier: OfficeTier): Seat[] {
    const W = this.cols * TILE;
    const H = this.rows * TILE;

    // floor fills the whole room
    this.add.tileSprite(0, 0, W, H, FLOOR_KEY[tier.floor]).setOrigin(0, 0).setDepth(DEPTH.ground);

    // walls (drawn): north face with cap + baseboard, thin dark exterior elsewhere
    const g = this.add.graphics().setDepth(DEPTH.wall);
    const bandH = 2 * TILE;
    g.fillStyle(WALL_FACE, 1).fillRect(0, 0, W, bandH);
    g.fillStyle(WALL_FACE_SHADE, 1).fillRect(0, 14, W, 2); // subtle panel seam
    g.fillStyle(WALL_CAP, 1).fillRect(0, 0, W, 10); // crown cap
    g.fillStyle(WALL_BASE, 1).fillRect(0, bandH - 7, W, 7); // baseboard
    g.fillStyle(WALL_LINE, 1).fillRect(0, bandH - 1, W, 1); // base line
    // soft shadow the wall throws on the floor
    g.fillStyle(0x000000, 0.12).fillRect(0, bandH, W, 5);
    // exterior walls: dark caps on left/right/bottom
    const side = 12;
    g.fillStyle(WALL_CAP, 1);
    g.fillRect(0, 0, side, H);
    g.fillRect(W - side, 0, side, H);
    g.fillRect(0, H - side, W, side);
    g.lineStyle(2, WALL_LINE, 1).strokeRect(1, 1, W - 2, H - 2);

    for (let tx = 0; tx < this.cols; tx++) {
      this.markSolid(tx, 0);
      this.markSolid(tx, 1);
      this.markSolid(tx, this.rows - 1);
    }
    for (let ty = 0; ty < this.rows; ty++) {
      this.markSolid(0, ty);
      this.markSolid(this.cols - 1, ty);
    }

    this.hangFixtures(W, bandH);
    this.placeFloorProps();

    const seats: Seat[] = [];
    for (const d of tier.desks) {
      const deskBottom = d.ty * TILE + DESK_H;
      const cx = d.tx * TILE + DESK_W / 2;
      // desk surface (2 tiles wide)
      this.add.image(d.tx * TILE, deskBottom, "desk").setOrigin(0, 1).setDepth(DEPTH.entityBase + deskBottom);
      // monitor sits on the desk (render just in front of the surface)
      this.add.image(cx, d.ty * TILE + 28, "monitor").setOrigin(0.5, 1).setDepth(DEPTH.entityBase + deskBottom + 1);
      // chair below the desk — NO hitbox; y-sorted so it occludes whoever sits/walks behind it
      const chairBottom = deskBottom + CHAIR_DROP;
      this.add.image(cx, chairBottom, "chair").setOrigin(0.5, 1).setDepth(DEPTH.entityBase + chairBottom);
      // desk tiles are solid; chair tiles are not
      this.markSolid(d.tx, d.ty);
      this.markSolid(d.tx + 1, d.ty);
      // seat: NPC sits just behind the chair (chair occludes their lower body)
      seats.push({ x: cx, y: chairBottom - 8 });
    }

    for (const p of tier.plants) {
      const px = p.tx * TILE + TILE / 2;
      const py = (p.ty + 1) * TILE;
      this.add.image(px, py, "plant_tall").setOrigin(0.5, 1).setDepth(DEPTH.entityBase + py);
      this.markSolid(p.tx, p.ty);
    }

    return seats;
  }

  /** Wall fixtures hang on the north face, spread to fit the room width. */
  private hangFixtures(W: number, bandH: number): void {
    const fixtures = this.cols >= 16
      ? ["teamphoto", "tv", "cert", "board_chart", "art_a", "board_pie"]
      : ["teamphoto", "tv", "board_chart"];
    const margin = 2.2 * TILE;
    const span = W - margin * 2;
    const y = bandH - 6;
    fixtures.forEach((key, i) => {
      const x = fixtures.length === 1 ? W / 2 : margin + (span * i) / (fixtures.length - 1);
      this.add.image(x, y, key).setOrigin(0.5, 1).setDepth(DEPTH.wall + 1);
    });
  }

  /** Standing props along the walls: shelves, water cooler, vending, printer, plants. */
  private placeFloorProps(): void {
    const stand = (key: string, tx: number, ty: number, wide = 1): void => {
      const x = tx * TILE + (wide * TILE) / 2;
      const y = (ty + 1) * TILE;
      this.add.image(x, y, key).setOrigin(0.5, 1).setDepth(DEPTH.entityBase + y);
      for (let i = 0; i < wide; i++) this.markSolid(tx + i, ty);
    };
    const right = this.cols - 2;
    const bottom = this.rows - 2;
    // against the north wall, clear of the fixtures' sight-lines
    stand("shelf_books", right - 1, 2, 2);
    stand("watercooler", 1, 2);
    // along the side/bottom walls
    stand("vending", right, Math.floor(this.rows / 2), 1);
    stand("printer", 1, bottom - 1, 2);
    if (this.cols >= 16) {
      stand("plant_tall", 1, Math.floor(this.rows / 2));
      stand("plant_tall", right, 2);
    }
  }

  /** BFS over the tile grid; waypoints are tile centres plus the exact endpoint. */
  private makePathProvider(): PathProvider {
    const walkable = (tx: number, ty: number): boolean =>
      tx >= 0 && ty >= 0 && tx < this.cols && ty < this.rows && !this.solid.has(this.key(tx, ty));
    const toTile = (px: number, py: number): { tx: number; ty: number } | null => {
      const tx = Math.floor(px / TILE);
      const ty = Math.floor(py / TILE);
      if (walkable(tx, ty)) return { tx, ty };
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
        if (walkable(tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
      }
      return null;
    };
    return {
      findPath: (fromX, fromY, toX, toY) => {
        const start = toTile(fromX, fromY);
        const goal = toTile(toX, toY);
        if (!start || !goal) return null;
        const startKey = this.key(start.tx, start.ty);
        const goalKey = this.key(goal.tx, goal.ty);
        const parent = new Map<string, string | null>([[startKey, null]]);
        const queue: Array<{ tx: number; ty: number }> = [start];
        let found = startKey === goalKey;
        while (queue.length > 0 && !found) {
          const cur = queue.shift();
          if (!cur) break;
          for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
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
        let cursor: string | null = goalKey;
        while (cursor) {
          tiles.unshift(cursor);
          cursor = parent.get(cursor) ?? null;
        }
        const pts = tiles.map((k) => {
          const [txs, tys] = k.split(",");
          return { x: Number(txs) * TILE + TILE / 2, y: Number(tys) * TILE + TILE / 2 };
        });
        pts.shift(); // current tile centre — already (roughly) here
        pts.push({ x: toX, y: toY });
        return pts;
      },
      randomFloor: (x, y, radius) => {
        for (let i = 0; i < 24; i++) {
          const tx = Math.floor((x + (Math.random() * 2 - 1) * radius) / TILE);
          const ty = Math.floor((y + (Math.random() * 2 - 1) * radius) / TILE);
          if (walkable(tx, ty)) return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
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
        // delegate messages look like "→ Name (Title): task" — walk to that teammate
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
    const player = this.add.sprite(spawn.x, spawn.y, key, idleFrame("down")).setOrigin(0.5, 0.86);
    this.player = player;
    this.cameras.main.startFollow(player, true, 0.12, 0.12);
  }

  // ---- movement ------------------------------------------------------------
  override update(_t: number, dms: number): void {
    const player = this.player;
    if (!player) return;
    const dt = Math.min(dms, 50) / 1000;
    let dx = 0;
    let dy = 0;
    if (this.keys.A.isDown || this.cursors.left.isDown) dx -= 1;
    if (this.keys.D.isDown || this.cursors.right.isDown) dx += 1;
    if (this.keys.W.isDown || this.cursors.up.isDown) dy -= 1;
    if (this.keys.S.isDown || this.cursors.down.isDown) dy += 1;

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
    player.setDepth(DEPTH.entityBase + player.y);
    this.npcs?.update();
  }

  private moveResolved(mx: number, my: number): void {
    const player = this.player;
    if (!player) return;
    const hw = 8;
    const hh = 5;
    const hit = (px: number, py: number) =>
      this.solidAtPx(px - hw, py - hh) || this.solidAtPx(px + hw, py - hh) || this.solidAtPx(px - hw, py + hh) || this.solidAtPx(px + hw, py + hh);
    const nx = player.x + mx;
    if (!hit(nx, player.y)) player.x = nx;
    const ny = player.y + my;
    if (!hit(player.x, ny)) player.y = ny;
  }
}
