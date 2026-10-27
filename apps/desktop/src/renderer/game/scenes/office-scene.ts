import { Input, Scene, Scenes } from "phaser";
import type Phaser from "phaser";
import { listen } from "@/renderer/page-events";
import {
  companyQuery,
  employeesQuery,
  openTasksQuery,
  read,
  watch,
} from "@/renderer/state/queries";
import { characterAnims, idleFrame } from "@/renderer/game/character-sheet";
import type { CharacterAnims } from "@/renderer/game/character-sheet";
import { BootGate } from "@/renderer/game/boot-gate";
import { loadCharacter } from "@/renderer/game/characters";
import { ClickWalk } from "@/renderer/game/click-walk";
import type { Walker } from "@/renderer/game/click-walk";
import { WALK_SPEED, ZOOM } from "@/renderer/game/config";
import { facingToward } from "@/renderer/game/movement";
import type { Seat } from "@/renderer/game/npc";
import type { Poi } from "@/renderer/game/npc-idle";
import { NpcManager } from "@/renderer/game/npcs";
import { OFFICE } from "@/renderer/game/office-layout";
import type { PixelPoint } from "@/renderer/game/office-layout-schema";
import { poseForToolKind } from "@/renderer/game/office-poses";
import { BEHIND_CHAIR_RISE, behindChair, seatDepth } from "@/renderer/game/seat-depth";
import { textureMasks } from "@/renderer/game/texture-masks";
import type { OpaqueMask } from "@/renderer/game/opaque-mask";
import { characterDepth } from "@/renderer/game/office-depth";
import type { ActivityEvent } from "@repo/domain/activity";
import { CHAR_ORIGIN_X, CHAR_ORIGIN_Y } from "@repo/domain/character-frame";
import type { Dir } from "@repo/domain/character-frame";
import { hear, tell } from "@/renderer/game/office-port";
import { DEFAULT_FOUNDER_SEED, taskIn } from "@repo/domain/domain";
import type { Employee, Task } from "@repo/domain/domain";
import { bodyBlockedAt } from "@/renderer/game/office-grid";

const FACING_OFFSET = {
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
} satisfies Record<Dir, { x: number; y: number }>;

const WORKSPACE_KIT_PATH = "/workspace-kit";

/** The founder on screen: their sprite and the anims cut from its sheet. */
interface Player {
  readonly sprite: Phaser.GameObjects.Sprite;
  readonly anims: CharacterAnims;
}

/** What the camera shows past the office's edge. */
const OUTSIDE = 0x14_16_1f;

/** Idle-life spots from the layout: the POIs get faced, the rest seats get sat on. */
const IDLE_POIS: readonly Poi[] = [
  ...OFFICE.pois.map((p) => ({ face: p.face, x: p.x, y: p.y })),
  ...OFFICE.seats.flatMap((seat): Poi[] =>
    seat.role === "rest" ? [{ face: "down", sit: seat.sit, x: seat.x, y: seat.y }] : [],
  ),
];

const roundQuad = (obj: Phaser.GameObjects.GameObject): void => {
  obj.vertexRoundMode = "fullAuto";
};

/** Who waits on the founder: they keep the "!" whatever they do, and nobody else does. */
const waitingOf = (tasks: readonly Task[]): Set<string> =>
  new Set(tasks.flatMap((t) => (taskIn("blocked")(t) && t.assigneeId ? [t.assigneeId] : [])));

export class OfficeScene extends Scene {
  private player?: Player | undefined;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys?: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;
  private facing: Dir = "down";
  private npcs?: NpcManager | undefined;
  /**
   * What the office hears while it boots waits for its snapshot, then replays in
   * order: statuses and asks are last-writer-wins and a spawn of someone already
   * there is a no-op, so replaying what the snapshot already saw is harmless.
   */
  private readonly npcEvents = new BootGate<NpcManager>();
  private clickWalk?: ClickWalk | undefined;
  private modalOpen = false;
  /** Bumped by boot() and by teardown: an await in boot() that outlives its scene must not touch it or the next one. */
  private generation = 0;
  private activityUnsub?: () => void;
  private stopWatchingAsks?: (() => void) | undefined;

  constructor() {
    super("office");
  }

  preload() {
    // the loader skips a key it already holds or has queued, so a sprite placed twice loads once
    for (const placement of OFFICE.placements) {
      this.load.image(placement.key, placement.url);
    }
    this.load.spritesheet("emotes", `${WORKSPACE_KIT_PATH}/emotes.png`, {
      frameHeight: 32,
      frameWidth: 32,
    });
  }

  create() {
    this.cameras.main.setBackgroundColor(OUTSIDE);
    // roundPixels alone rounds nothing here: the default vertexRoundMode trusts
    // only an unzoomed camera, and this one is zoomed ZOOMx. An integer zoom keeps
    // every corner on the same fraction, so rounding whole quads is safe and is
    // what keeps a walking sprite off the half pixel.
    this.events.on(Scenes.Events.ADDED_TO_SCENE, roundQuad);
    const kb = this.input.keyboard;
    if (!kb) {
      throw new Error("keyboard input unavailable");
    }
    this.cursors = kb.createCursorKeys();
    this.keys = {
      A: kb.addKey(Input.Keyboard.KeyCodes.A),
      D: kb.addKey(Input.Keyboard.KeyCodes.D),
      S: kb.addKey(Input.Keyboard.KeyCodes.S),
      W: kb.addKey(Input.Keyboard.KeyCodes.W),
    };
    kb.addKey(Input.Keyboard.KeyCodes.SPACE).on("down", () => this.tryAction());
    kb.addKey(Input.Keyboard.KeyCodes.E).on("down", () => this.tryAction());

    // Click to go there. The HUD sits over this canvas but is pointer-events-none except
    // on its own controls, so a click on a button never reaches us.
    this.input.on(Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      if (!this.modalOpen) {
        this.clickWalk?.onPointerDown({ x: p.worldX, y: p.worldY });
      }
    });

    void this.boot();

    // live hires and releases come and go through the door
    const onSpawn = (emp: Employee) =>
      this.npcEvents.run((npcs) => {
        void npcs.spawn(emp, "door");
      });
    const onDespawn = (employeeId: string) =>
      this.npcEvents.run((npcs) => npcs.despawn(employeeId, "door"));
    const onModal = (open: boolean) => {
      this.modalOpen = open;
      if (open) {
        this.clickWalk?.cancel();
      }
      this.claimKeyboard();
    };
    const onCompanyReady = () => this.scene.restart();
    const stopHearing = [
      hear(this.game, "spawn-employee", onSpawn),
      hear(this.game, "despawn-employee", onDespawn),
      hear(this.game, "ui-modal", onModal),
      hear(this.game, "company-ready", onCompanyReady),
    ];
    tell(this.game, "office-input-ready", null);
    // Phaser captures its keys on window and cancels their default whoever has
    // focus — a space typed into the team room would never land. The keyboard
    // is the game's only while no text field is being typed into.
    const onFocusChange = () => this.claimKeyboard();
    document.addEventListener("focusin", onFocusChange);
    document.addEventListener("focusout", onFocusChange);
    this.claimKeyboard();
    this.subscribeActivity();

    const teardown = () => {
      this.events.off(Scenes.Events.SHUTDOWN, teardown);
      this.events.off(Scenes.Events.DESTROY, teardown);
      this.generation += 1;
      this.npcEvents.shut();
      this.events.off(Scenes.Events.ADDED_TO_SCENE, roundQuad);
      this.activityUnsub?.();
      this.stopWatchingAsks?.();
      this.stopWatchingAsks = undefined;
      document.removeEventListener("focusin", onFocusChange);
      document.removeEventListener("focusout", onFocusChange);
      for (const stop of stopHearing) {
        stop();
      }
      this.npcs?.destroy();
      this.clickWalk?.cancel();
      this.clickWalk = undefined;
      this.npcs = undefined;
      this.player = undefined;
    };
    this.events.once(Scenes.Events.SHUTDOWN, teardown);
    // game.destroy() emits only DESTROY, never SHUTDOWN
    this.events.once(Scenes.Events.DESTROY, teardown);
  }

  /** The game owns the keys when nothing else is typing and no panel is up. */
  private claimKeyboard(): void {
    const kb = this.input.keyboard;
    if (!kb) {
      return;
    }
    const el = document.activeElement;
    const typing =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable);
    const ours = !this.modalOpen && !typing;
    kb.enabled = ours;
    if (ours) {
      kb.enableGlobalCapture();
    } else {
      kb.disableGlobalCapture();
      // a disabled plugin drops the key-up of whatever is held, which would stay down
      // once the keys come back: walking on its own, or eating the next press
      kb.resetKeys();
    }
  }

  private async boot(): Promise<void> {
    this.generation += 1;
    const { generation } = this;
    this.npcEvents.boot();
    try {
      await this.bootOffice(generation);
    } catch (error) {
      console.error("Could not boot the office", error);
      // left booting, the gate would hold every later event for the scene's life;
      // a boot already replaced must leave its successor's gate alone
      if (generation === this.generation) {
        this.npcEvents.shut();
      }
    }
  }

  private async bootOffice(generation: number): Promise<void> {
    const masks = textureMasks(this.textures);
    const seats = this.buildRoom(masks);

    const cam = this.cameras.main;
    cam.removeBounds();
    cam.setZoom(ZOOM);
    cam.setRoundPixels(true);
    this.centerCameraOn(OFFICE.spawn);

    // the window's answers, or its reads in flight: main is asked once for both
    const company = await read(companyQuery);
    if (generation !== this.generation) {
      return;
    }
    // the founder's sheet and the roster are independent, so both are asked for at once
    const seed = company ? company.founderSpriteSeed : DEFAULT_FOUNDER_SEED;
    const [playerKey, employees, tasks] = await Promise.all([
      loadCharacter(this, seed),
      company ? read(employeesQuery) : [],
      company ? read(openTasksQuery) : [],
    ]);
    if (generation !== this.generation) {
      return;
    }
    if (company) {
      // the asks as main says them each time they are read again, held until the office opens
      this.stopWatchingAsks = watch(openTasksQuery, waitingOf, (asking) =>
        this.npcEvents.run((team) => team.setWaiting(asking)),
      );
    }
    const player = this.placePlayer(playerKey);
    const npcs = new NpcManager(this, seats, OFFICE.grid, IDLE_POIS, OFFICE.door);
    this.npcs = npcs;
    this.clickWalk = new ClickWalk(this, OFFICE.grid, this.walkerOf(player), npcs, (id) =>
      this.talkTo(id),
    );

    // the office is already staffed when it opens: nobody parades in on boot
    for (const emp of employees) {
      await npcs.spawn(emp, "settled");
    }
    if (generation !== this.generation) {
      return;
    }
    const waiting = waitingOf(tasks);
    for (const id of waiting) {
      npcs.setState(id, "blocked");
    }
    npcs.setWaiting(waiting);
    this.npcEvents.open(npcs);
  }

  private buildRoom(masks: (key: string) => OpaqueMask | null): Seat[] {
    const room = OFFICE.placements.map((placement) =>
      this.add
        .image(placement.x, placement.y, placement.key)
        .setOrigin(0, 0)
        .setDepth(placement.depth)
        .setFlip(placement.flipX, placement.flipY),
    );
    return OFFICE.seats
      .filter((seat) => seat.role === "work")
      .map((seat) => ({
        depth: seatDepth(seat, room, (image) => masks(image.texture.key)),
        facing: seat.facing,
        rise: behindChair(seat) ? BEHIND_CHAIR_RISE : 0,
        x: seat.x,
        y: seat.y,
      }));
  }

  private subscribeActivity(): void {
    this.activityUnsub = listen("activity", (e: ActivityEvent) => {
      switch (e.kind) {
        // the founder's and the office's lines have nobody in the office to say them
        case "chat": {
          const speaker = e.employeeId;
          if (speaker !== null) {
            this.npcEvents.run((npcs) => npcs.onChat(speaker, e.message, e.payload.to));
          }
          return;
        }
        // what they are doing right now, as the sprite can show it
        case "tool_call": {
          const pose = poseForToolKind(e.payload.kind);
          this.npcEvents.run((npcs) => npcs.onTool(e.employeeId, pose));
          return;
        }
        // an ask raised mid-run: the "!" goes up now, not when the run settles
        case "run.ask": {
          this.npcEvents.run((npcs) => npcs.onAsk(e.employeeId));
          return;
        }
        case "run.start": {
          this.npcEvents.run((npcs) => npcs.setState(e.employeeId, "working"));
          return;
        }
        // sent by the run itself, so it frees them even when the settle threw
        case "run.end": {
          const { outcome, settled } = e.payload;
          const asks = settled === null ? outcome.kind === "blocked" : settled === "blocked";
          const state = asks ? "blocked" : "idle";
          this.npcEvents.run((npcs) => npcs.setState(e.employeeId, state));
          return;
        }
        // an answer requeues the task, but its run may not start at once: drop the "!" now,
        // unless other work of theirs was queued while an ask of theirs still waits
        case "status": {
          if (e.message === "queued") {
            this.npcEvents.run((npcs) => npcs.unblock(e.employeeId));
          }
          break;
        }
        default: {
          break;
        }
      }
    });
  }

  private talkTo(employeeId: string): void {
    tell(this.game, "npc-interact", { employeeId });
  }

  /** SPACE / E: talk to whoever is right in front of the founder. */
  private tryAction(): void {
    const { player } = this;
    const { npcs } = this;
    if (!player || !npcs) {
      return;
    }
    const off = FACING_OFFSET[this.facing];
    const id = npcs.interactAt(player.sprite.x + off.x * 26, player.sprite.y + off.y * 26);
    if (id) {
      this.talkTo(id);
    }
  }

  /** The founder as click-to-walk drives them: position from the sprite, moves through collision. */
  private walkerOf(player: Player): Walker {
    return {
      face: (dir) => this.face(dir),
      move: (dx, dy) => this.moveResolved(dx, dy),
      place: (at) => player.sprite.setPosition(at.x, at.y),
      position: player.sprite,
      walk: (dir) => this.walk(dir),
    };
  }

  private placePlayer(key: string): Player {
    const sprite = this.add
      .sprite(OFFICE.spawn.x, OFFICE.spawn.y, key, idleFrame("down"))
      .setOrigin(CHAR_ORIGIN_X, CHAR_ORIGIN_Y);
    sprite.setDepth(characterDepth(sprite.y));
    const player = { anims: characterAnims(key), sprite };
    this.player = player;
    this.centerCameraOn(sprite);
    return player;
  }

  override update(_t: number, dms: number): void {
    const { player } = this;
    const { keys } = this;
    const { cursors } = this;
    if (!player || !keys || !cursors) {
      return;
    }
    const dt = Math.min(dms, 50) / 1000;
    let dx = 0;
    let dy = 0;
    if (keys.A.isDown || cursors.left.isDown) {
      dx -= 1;
    }
    if (keys.D.isDown || cursors.right.isDown) {
      dx += 1;
    }
    if (keys.W.isDown || cursors.up.isDown) {
      dy -= 1;
    }
    if (keys.S.isDown || cursors.down.isDown) {
      dy += 1;
    }

    if (dx !== 0 || dy !== 0) {
      // taking the keys back cancels wherever the click was sending us
      this.clickWalk?.cancel();
      const len = Math.hypot(dx, dy);
      this.moveResolved((dx / len) * WALK_SPEED * dt, (dy / len) * WALK_SPEED * dt);
      this.walk(facingToward(dx, dy));
    } else if (!this.clickWalk?.update(dt)) {
      this.stand();
    }
    const depth = characterDepth(player.sprite.y);
    if (player.sprite.depth !== depth) {
      player.sprite.setDepth(depth);
    }
    this.centerCameraOn(player.sprite);
    this.npcs?.update();
  }

  private walk(dir: Dir): void {
    this.facing = dir;
    const { player } = this;
    if (player) {
      player.sprite.play(player.anims.walk[dir], true);
    }
  }

  private face(dir: Dir): void {
    this.facing = dir;
    const sprite = this.player?.sprite;
    if (!sprite) {
      return;
    }
    sprite.anims.stop();
    sprite.setFrame(idleFrame(dir));
  }

  /** Come to rest on the standing frame — once, when the walk cycle is still going. */
  private stand(): void {
    if (this.player?.sprite.anims.isPlaying) {
      this.face(this.facing);
    }
  }

  private moveResolved(mx: number, my: number): void {
    const sprite = this.player?.sprite;
    if (!sprite) {
      return;
    }
    const { grid } = OFFICE;
    const nx = sprite.x + mx;
    if (!bodyBlockedAt(grid, nx, sprite.y)) {
      sprite.x = nx;
    }
    const ny = sprite.y + my;
    if (!bodyBlockedAt(grid, sprite.x, ny)) {
      sprite.y = ny;
    }
  }

  /** Keep the player dead-centre always (no clamping to the room edges). */
  private centerCameraOn(point: PixelPoint): void {
    this.cameras.main.centerOn(point.x, point.y);
  }
}
