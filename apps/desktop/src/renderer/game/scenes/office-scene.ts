import { Input, Scene, Scenes } from "phaser";
import type Phaser from "phaser";
import { listen } from "@/renderer/page-events";
import { reportFault } from "@/renderer/report-fault";
import {
  companyQuery,
  employeesQuery,
  held,
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

interface Player {
  readonly sprite: Phaser.GameObjects.Sprite;
  readonly anims: CharacterAnims;
}

const OUTSIDE = 0x14_16_1f;

const IDLE_POIS: readonly Poi[] = [
  ...OFFICE.pois.map((p) => ({ face: p.face, x: p.x, y: p.y })),
  ...OFFICE.seats.flatMap(
    (seat) =>
      (seat.role === "rest"
        ? [{ face: "down", sit: seat.sit, x: seat.x, y: seat.y }]
        : []) satisfies Poi[],
  ),
];

const roundQuad = (obj: Phaser.GameObjects.GameObject) => {
  obj.vertexRoundMode = "fullAuto";
};

const waitingOf = (tasks: readonly Task[]) =>
  new Set<string>(
    tasks.flatMap((t) => (taskIn("blocked")(t) && t.assigneeId ? [t.assigneeId] : [])),
  );

export class OfficeScene extends Scene {
  private player?: Player | undefined;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys?: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;
  private facing: Dir = "down";
  private npcs?: NpcManager | undefined;
  private readonly npcEvents = new BootGate<NpcManager>();
  private clickWalk?: ClickWalk | undefined;
  private modalOpen = false;
  private generation = 0;
  private activityUnsub?: () => void;
  private stopWatchingAsks?: (() => void) | undefined;

  constructor() {
    super("office");
  }

  preload() {
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

    this.input.on(Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      if (!this.modalOpen) {
        this.clickWalk?.onPointerDown({ x: p.worldX, y: p.worldY });
      }
    });

    void this.boot();

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

    const onResynced = () =>
      this.npcEvents.run((npcs) => {
        const roster = held(employeesQuery);
        const tasks = held(openTasksQuery);

        if (roster && tasks) {
          npcs.resync(roster, waitingOf(tasks));
        }
      });

    const stopHearing = [
      hear(this.game, "spawn-employee", onSpawn),
      hear(this.game, "despawn-employee", onDespawn),
      hear(this.game, "ui-modal", onModal),
      hear(this.game, "company-ready", onCompanyReady),
      hear(this.game, "resynced", onResynced),
    ];

    tell(this.game, "office-input-ready", null);
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
    this.events.once(Scenes.Events.DESTROY, teardown);
  }

  private claimKeyboard() {
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
      kb.resetKeys();
    }
  }

  private async boot() {
    this.generation += 1;
    const { generation } = this;
    this.npcEvents.boot();

    try {
      await this.bootOffice(generation);
    } catch (error) {
      console.error("Could not boot the office", error);
      reportFault("office-boot", error);

      if (generation === this.generation) {
        this.npcEvents.shut();
      }
    }
  }

  private async bootOffice(generation: number) {
    const masks = textureMasks(this.textures);
    const seats = this.buildRoom(masks);

    const cam = this.cameras.main;
    cam.removeBounds();
    cam.setZoom(ZOOM);
    cam.setRoundPixels(true);
    this.centerCameraOn(OFFICE.spawn);

    const company = await read(companyQuery);

    if (generation !== this.generation) {
      return;
    }

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

  private buildRoom(masks: (key: string) => OpaqueMask | null) {
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

  private subscribeActivity() {
    this.activityUnsub = listen("activity", (e: ActivityEvent) => {
      switch (e.kind) {
        case "chat": {
          const speaker = e.employeeId;

          if (speaker !== null) {
            this.npcEvents.run((npcs) => npcs.onChat(speaker, e.message, e.payload.to));
          }

          return;
        }

        case "tool_call": {
          const pose = poseForToolKind(e.payload.kind);
          this.npcEvents.run((npcs) => npcs.onTool(e.employeeId, pose));

          return;
        }

        case "run.ask": {
          this.npcEvents.run((npcs) => npcs.onAsk(e.employeeId));

          return;
        }

        case "run.start": {
          this.npcEvents.run((npcs) => npcs.setState(e.employeeId, "working"));

          return;
        }

        case "run.end": {
          const { outcome, settled } = e.payload;
          const asks = settled === null ? outcome.kind === "blocked" : settled === "blocked";
          const state = asks ? "blocked" : "idle";
          this.npcEvents.run((npcs) => npcs.setState(e.employeeId, state));

          return;
        }

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

  private talkTo(employeeId: string) {
    tell(this.game, "npc-interact", { employeeId });
  }

  private tryAction() {
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

  private walkerOf(player: Player) {
    return {
      face: (dir) => this.face(dir),
      move: (dx, dy) => this.moveResolved(dx, dy),
      place: (at) => player.sprite.setPosition(at.x, at.y),
      position: player.sprite,
      walk: (dir) => this.walk(dir),
    } satisfies Walker;
  }

  private placePlayer(key: string) {
    const sprite = this.add
      .sprite(OFFICE.spawn.x, OFFICE.spawn.y, key, idleFrame("down"))
      .setOrigin(CHAR_ORIGIN_X, CHAR_ORIGIN_Y);

    sprite.setDepth(characterDepth(sprite.y));
    const player = { anims: characterAnims(key), sprite };
    this.player = player;
    this.centerCameraOn(sprite);

    return player;
  }

  override update(_t: number, dms: number) {
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

  private walk(dir: Dir) {
    this.facing = dir;
    const { player } = this;

    if (player) {
      player.sprite.play(player.anims.walk[dir], true);
    }
  }

  private face(dir: Dir) {
    this.facing = dir;
    const sprite = this.player?.sprite;

    if (!sprite) {
      return;
    }

    sprite.anims.stop();
    sprite.setFrame(idleFrame(dir));
  }

  private stand() {
    if (this.player?.sprite.anims.isPlaying) {
      this.face(this.facing);
    }
  }

  private moveResolved(mx: number, my: number) {
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

  private centerCameraOn(point: PixelPoint) {
    this.cameras.main.centerOn(point.x, point.y);
  }
}
