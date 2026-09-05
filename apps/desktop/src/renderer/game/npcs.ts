import Phaser from "phaser";
import { DEPTH } from "@/renderer/game/config";
import {
  characterAnims,
  characterDepth,
  CHAR_ORIGIN_X,
  CHAR_ORIGIN_Y,
  idleFrame,
  SEAT_CROP,
  type CharacterAnims,
  type Dir,
  type SitSide,
} from "@/renderer/game/character-sheet";
import { loadCharacter, unloadCharacter } from "@/renderer/game/characters";
import { randomFloor, stepToward } from "@/renderer/game/movement";
import type { PixelPoint } from "@/renderer/game/office-layout";
import { planSeats, type SeatPlan } from "@/renderer/game/office-placement";
import { DEFAULT_WORK_POSE, type WorkPose } from "@/renderer/game/office-poses";
import type { Employee } from "@/shared/domain";
import { findPath, nearestFloor, type WalkGrid } from "@/shared/office-grid";

/**
 * What the scheduler says an employee is doing. Only a working employee has a pose:
 * it is what their last tool call looked like, and means nothing once the run ends.
 */
type Activity =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly pose: WorkPose }
  | { readonly kind: "blocked" };

export type NpcState = Activity["kind"];

/** How an employee joins or leaves: already in place (boot), or through the door (live). */
export type Passage = "settled" | "door";

/** A desk seat (px) an employee occupies. Owned by the office scene, sized to the active tier. */
export interface Seat {
  readonly x: number;
  readonly y: number;
  /** Depth its occupant renders at while seated — above the workstation, so the chair
   *  back doesn't swallow them. Computed by seat-depth.ts from the built room. */
  readonly depth: number;
}

/** A point of interest idle employees visit: stand at (x,y) facing `face`,
 *  or sit (break-room chair) playing the matching sit animation. */
export interface Poi {
  readonly x: number;
  readonly y: number;
  readonly face: Dir;
  readonly sit?: SitSide;
}

interface WalkPlan {
  path: PixelPoint[];
  onArrive?: () => void;
}

interface Bubble {
  root: Phaser.GameObjects.Container;
  until: number;
}

/**
 * Where an employee is in their day — the director's phases.
 *
 *   queued    hired; waiting outside for their turn through the door
 *   entering  walking from the door to their seat
 *   settled   in the office: at their desk, or living the idle life
 *   leaving   walking to the door; gone when they get there
 */
type Phase = "queued" | "entering" | "settled" | "leaving";

interface Npc {
  id: string;
  name: string;
  key: string;
  anims: CharacterAnims;
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  emote?: Phaser.GameObjects.Sprite;
  /** The emote's bob, tweened on its own so the emote can also follow a walker. */
  emoteBob?: { dy: number };
  bubble?: Bubble;
  /** Their workstation, or null when the office has run out of desks. */
  seat: Seat | null;
  phase: Phase;
  activity: Activity;
  /** They asked the founder something this run — "!" until the run settles. */
  asking: boolean;
  plan: WalkPlan | null;
  nextWanderAt: number;
  pendingTimer?: Phaser.Time.TimerEvent;
}

const EMOTE_FRAME = { alert: 0, think: 1 } satisfies Record<"alert" | "think", number>;
const NPC_SPEED = 64; // px/s
const INTERACT_RADIUS = 38;
const BUBBLE_MS = 3200;
/** Gap between two hires walking through the door — a procession, not a spawn burst. */
const ARRIVAL_INTERVAL_MS = 480;
const FADE_MS = 220;
/** The hover label hangs below the feet: above the head is where bubbles and emotes live. */
const LABEL_DY = 10;
const EMOTE_DY = -58;
const BUBBLE_DY = -56;
const HOVERABLE = { useHandCursor: true };
const IDLE_CHAT_LINES: readonly string[] = [
  "quick sync",
  "looks good",
  "ship it",
  "coffee?",
  "backlog?",
];

/** Where to stand to talk to someone: just off their right shoulder. */
function besideOf(at: PixelPoint): PixelPoint {
  return { x: at.x + 26, y: at.y + 6 };
}

function setDepthIfChanged(sprite: Phaser.GameObjects.Sprite, depth: number): void {
  if (sprite.depth !== depth) sprite.setDepth(depth);
}

/**
 * Hired employees as living NPCs: they walk in through the door, sit to work,
 * wander when idle, walk to teammates to deliver real team-chat messages,
 * raise "!" when they ask the founder something, and walk out when released.
 *
 * Seating is planned, not grabbed: `planSeats` decides who sits where from the
 * whole roster and the previous plan, and this class only turns the diffs into
 * walking (see office-placement.ts).
 */
export class NpcManager {
  private npcs = new Map<string, Npc>();
  private roster = new Map<string, Employee>();
  private seatPlan: SeatPlan = new Map();
  private arrivals: string[] = [];
  private nextArrivalAt = 0;
  // Phaser's loader is single-batch; serialize spawns so concurrent hires don't race it.
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private scene: Phaser.Scene,
    private seats: ReadonlyArray<Seat>,
    private grid: WalkGrid,
    private pois: ReadonlyArray<Poi>,
    private door: PixelPoint,
  ) {}

  spawn(emp: Employee, passage: Passage): Promise<void> {
    this.chain = this.chain.then(() => this.doSpawn(emp, passage)).catch(() => {});
    return this.chain;
  }

  private async doSpawn(emp: Employee, passage: Passage): Promise<void> {
    if (this.npcs.has(emp.id)) return;
    const key = `emp-${emp.id}`;
    await loadCharacter(this.scene, key, emp.spriteSeed);

    this.roster.set(emp.id, emp);
    const seat = this.seatFor(this.replan().get(emp.id));
    const start = passage === "settled" ? (seat ?? this.standingSpot()) : this.door;

    const sprite = this.scene.add
      .sprite(start.x, start.y, key, idleFrame("up"))
      .setOrigin(CHAR_ORIGIN_X, CHAR_ORIGIN_Y);
    // hoverable once they are actually in the room, not while queued unseen at the door
    if (passage === "settled") sprite.setInteractive(HOVERABLE);

    // Who this is and what runs them: the roster is mixed, and nothing else in
    // the office says which CLI a colleague is.
    const label = this.scene.add
      .text(start.x, start.y + LABEL_DY, `${emp.name} · ${emp.runner}`, {
        fontFamily: "monospace",
        fontSize: "10px",
        color: "#ffffff",
        backgroundColor: "#000000aa",
      })
      .setOrigin(0.5, 0)
      .setPadding(3, 1, 3, 1)
      .setDepth(DEPTH.emote)
      .setVisible(false);
    sprite.on(Phaser.Input.Events.GAMEOBJECT_POINTER_OVER, () => label.setVisible(true));
    sprite.on(Phaser.Input.Events.GAMEOBJECT_POINTER_OUT, () => label.setVisible(false));

    const npc: Npc = {
      id: emp.id,
      name: emp.name,
      key,
      anims: characterAnims(key),
      sprite,
      label,
      seat,
      phase: passage === "settled" ? "settled" : "queued",
      activity: { kind: "idle" },
      asking: false,
      plan: null,
      nextWanderAt: this.scene.time.now + 4000 + Math.random() * 8000,
    };
    this.npcs.set(emp.id, npc);
    if (passage === "door") {
      sprite.setAlpha(0);
      this.arrivals.push(emp.id);
    }
    this.setState(emp.id, emp.status === "working" ? "working" : "idle");
    this.applyDepth(npc);
  }

  // ---- seating (the director) ----------------------------------------------

  private seatFor(index: number | null | undefined): Seat | null {
    return index === null || index === undefined ? null : (this.seats[index] ?? null);
  }

  /** Somewhere to stand when there is no desk: just inside the door. */
  private standingSpot(): PixelPoint {
    return randomFloor(this.grid, this.door, 64) ?? this.door;
  }

  /**
   * Re-plan seating for the roster and route anyone whose seat changed.
   * Incumbents never move (planSeats keeps them), so in practice this is how a
   * colleague who was standing gets the desk a released teammate freed.
   */
  private replan(): SeatPlan {
    const employees = [...this.roster.values()].map((e) => ({ id: e.id, deskIndex: e.deskIndex }));
    const next = planSeats(this.seats.length, employees, this.seatPlan);
    this.seatPlan = next;
    for (const [id, index] of next) {
      const npc = this.npcs.get(id);
      if (!npc) continue;
      const seat = this.seatFor(index);
      if (seat === npc.seat) continue;
      npc.seat = seat;
      if (npc.phase === "entering") this.routeIn(npc);
      else if (npc.phase === "settled" && npc.activity.kind !== "idle") this.goToSeat(npc);
    }
    return next;
  }

  /** Let the next hire in the queue through the door. */
  private releaseArrival(now: number): void {
    if (this.arrivals.length === 0 || now < this.nextArrivalAt) return;
    const id = this.arrivals.shift();
    const npc = id === undefined ? undefined : this.npcs.get(id);
    if (!npc) return;
    this.nextArrivalAt = now + ARRIVAL_INTERVAL_MS;
    npc.phase = "entering";
    npc.sprite.setPosition(this.door.x, this.door.y);
    npc.sprite.setInteractive(HOVERABLE);
    this.scene.tweens.add({ targets: npc.sprite, alpha: 1, duration: FADE_MS });
    this.applyLook(npc); // whatever they were asked or told while queued shows now
    this.routeIn(npc);
  }

  /** Walk from wherever they are to their seat (or a standing spot), then settle. */
  private routeIn(npc: Npc): void {
    const dest = npc.seat ?? this.standingSpot();
    if (!this.walkTo(npc, dest, () => this.settle(npc))) this.settle(npc);
  }

  private settle(npc: Npc): void {
    npc.phase = "settled";
    if (npc.seat) npc.sprite.setPosition(npc.seat.x, npc.seat.y);
    npc.nextWanderAt = this.scene.time.now + 1500 + Math.random() * 3000;
    this.applyLook(npc);
  }

  /** Back to the desk — walking, or a snap when there is no way through. */
  private goToSeat(npc: Npc): void {
    const seat = npc.seat;
    if (!seat || this.atSeat(npc)) {
      this.applyLook(npc);
      return;
    }
    if (!this.walkTo(npc, seat, () => this.applyLook(npc))) {
      npc.sprite.setPosition(seat.x, seat.y);
      this.applyLook(npc);
    }
  }

  /** Out through the door. Their seat is already someone else's to claim. */
  private leave(npc: Npc): void {
    npc.phase = "leaving";
    this.clearPending(npc);
    this.clearEmote(npc);
    npc.label.setVisible(false);
    npc.sprite.disableInteractive();
    if (npc.bubble) {
      npc.bubble.root.destroy();
      npc.bubble = undefined;
    }
    const gone = (): void => {
      this.scene.tweens.add({
        targets: npc.sprite,
        alpha: 0,
        duration: FADE_MS,
        onComplete: () => this.destroyNpc(npc),
      });
    };
    if (!this.walkTo(npc, this.door, gone)) this.destroyNpc(npc);
  }

  // ---- state ---------------------------------------------------------------
  setState(id: string, state: NpcState): void {
    const npc = this.npcs.get(id);
    if (!npc) return;
    npc.activity =
      state === "working" ? { kind: "working", pose: DEFAULT_WORK_POSE } : { kind: state };
    this.clearPending(npc);
    // idle: the run settled without a hanging question, or it was answered;
    // working: a new run, so whatever they asked last time has been dealt with
    if (state !== "blocked") npc.asking = false;
    if (state === "idle") {
      npc.nextWanderAt = this.scene.time.now + 700 + Math.random() * 1800;
      this.applyLook(npc);
      return;
    }
    // working / blocked employees belong at their computer
    if (npc.phase === "settled") this.goToSeat(npc);
    else this.applyLook(npc);
  }

  /** A tool call landed: hands on the keyboard, or eyes on the screen. */
  onTool(id: string, pose: WorkPose): void {
    const npc = this.npcs.get(id);
    if (!npc || npc.activity.kind !== "working") return;
    npc.activity = { kind: "working", pose };
    this.applyLook(npc);
  }

  /** They asked the founder something mid-run: raise the "!" now, not at run end. */
  onAsk(id: string): void {
    const npc = this.npcs.get(id);
    if (!npc) return;
    npc.asking = true;
    this.applyLook(npc);
  }

  private clearPending(npc: Npc): void {
    npc.pendingTimer?.remove();
    npc.pendingTimer = undefined;
  }

  private atSeat(npc: Npc): boolean {
    const seat = npc.seat;
    return seat !== null && Math.hypot(npc.sprite.x - seat.x, npc.sprite.y - seat.y) < 4;
  }

  private standFacing(npc: Npc, dir: Dir): void {
    npc.sprite.anims.stop();
    npc.sprite.setFrame(idleFrame(dir));
  }

  /**
   * What the sprite shows for (phase, activity), when it is standing still.
   * Walking is animated by the movement code; this is everything else.
   */
  private applyLook(npc: Npc): void {
    // still outside: an emote here would hang over the door with nobody under it
    if (npc.phase === "queued") {
      this.clearEmote(npc);
      return;
    }
    const { activity } = npc;
    if (activity.kind === "blocked" || npc.asking) this.showEmote(npc, EMOTE_FRAME.alert);
    else if (activity.kind === "working" && activity.pose === "thinking")
      this.showEmote(npc, EMOTE_FRAME.think);
    else this.clearEmote(npc);

    if (npc.phase !== "settled" || npc.plan) return;
    if (activity.kind === "idle") {
      this.standFacing(npc, "down");
      return;
    }
    const atDesk = this.atSeat(npc);
    if (atDesk && activity.kind === "working" && activity.pose === "typing") {
      npc.sprite.play(npc.anims.walk.up, true);
      return;
    }
    // reading / thinking / blocked: still, facing the screen (or the room, deskless)
    this.standFacing(npc, atDesk ? "up" : "down");
  }

  /**
   * Seated employees are drawn as a bust lifted above their workstation — the pack paints
   * its seated workers over the chair with the desk in front, which y-sorting alone can't
   * do (a chair's floor contact is south of its occupant, so it would hide them). Walkers
   * y-sort normally, on their soles.
   */
  private applyDepth(npc: Npc): void {
    const seat = npc.seat;
    if (!npc.plan && npc.phase === "settled" && seat && this.atSeat(npc)) {
      if (!npc.sprite.isCropped)
        npc.sprite.setCrop(SEAT_CROP.x, SEAT_CROP.y, SEAT_CROP.w, SEAT_CROP.h);
      setDepthIfChanged(npc.sprite, seat.depth);
      return;
    }
    if (npc.sprite.isCropped) npc.sprite.setCrop();
    setDepthIfChanged(npc.sprite, characterDepth(npc.sprite.y));
  }

  // ---- movement --------------------------------------------------------------
  private walkTo(npc: Npc, to: PixelPoint, onArrive?: () => void): boolean {
    const start = nearestFloor(this.grid, npc.sprite.x, npc.sprite.y);
    if (!start) return false;
    if (Math.hypot(npc.sprite.x - start.x, npc.sprite.y - start.y) > 2) {
      npc.sprite.setPosition(start.x, start.y);
    }
    const path = findPath(this.grid, npc.sprite, to);
    if (!path || path.length === 0) return false;
    npc.plan = { path, onArrive };
    return true;
  }

  /** Real team-chat staging: walk to the teammate it was for (or just speak in place),
   *  deliver the message as a speech bubble, then head home. */
  onChat(employeeId: string, message: string, to: string | null): void {
    const npc = this.npcs.get(employeeId);
    if (!npc || npc.phase === "queued") return;

    if (npc.phase !== "settled" || npc.activity.kind !== "idle") {
      this.showBubble(npc, message);
      return;
    }

    const present = [...this.npcs.values()].filter(
      (n) => n.id !== employeeId && n.phase === "settled",
    );
    const target = (to !== null && present.find((n) => n.id === to)) || present[0];

    // already busy walking (or nobody to visit) → just speak in place
    if (!target || npc.plan) {
      this.showBubble(npc, message);
      return;
    }

    const ok = this.walkTo(npc, besideOf(target.sprite), () => {
      this.showBubble(npc, message);
      npc.pendingTimer = this.scene.time.delayedCall(BUBBLE_MS - 400, () => {
        this.stepAway(npc);
      });
    });
    if (!ok) this.showBubble(npc, message);
  }

  /** Employees you can walk up to: everyone who has actually come through the door. */
  private present(): Npc[] {
    return [...this.npcs.values()].filter((n) => n.phase !== "queued");
  }

  /** Returns the employee id whose NPC is nearest the faced point (within range). */
  interactAt(px: number, py: number): string | null {
    let best: { id: string; d: number } | null = null;
    for (const npc of this.present()) {
      const d = Math.hypot(npc.sprite.x - px, npc.sprite.y - py);
      if (d <= INTERACT_RADIUS && (!best || d < best.d)) best = { id: npc.id, d };
    }
    return best?.id ?? null;
  }

  /** Where an employee is standing/sitting right now, for walking over to them. */
  positionOf(employeeId: string): PixelPoint | null {
    const npc = this.npcs.get(employeeId);
    return npc && npc.phase !== "queued" ? { x: npc.sprite.x, y: npc.sprite.y } : null;
  }

  /** Can someone standing at `point` strike up a conversation with `employeeId`? */
  inReach(employeeId: string, point: PixelPoint): boolean {
    const at = this.positionOf(employeeId);
    return at !== null && Math.hypot(at.x - point.x, at.y - point.y) <= INTERACT_RADIUS;
  }

  // ---- visuals ---------------------------------------------------------------
  private showEmote(npc: Npc, frame: number): void {
    if (!npc.emote) {
      npc.emote = this.scene.add
        .sprite(npc.sprite.x, npc.sprite.y + EMOTE_DY, "emotes", frame)
        .setDepth(DEPTH.emote);
      // the bob is an offset, not the emote's y: the "!" can go up mid-walk
      // (an ask while heading back to the desk) and has to keep up
      const bob = { dy: 0 };
      this.scene.tweens.add({
        targets: bob,
        dy: -4,
        duration: 480,
        yoyo: true,
        repeat: -1,
        ease: "Sine.InOut",
      });
      npc.emoteBob = bob;
    }
    npc.emote.setFrame(frame).setVisible(true);
  }
  private clearEmote(npc: Npc): void {
    npc.emote?.setVisible(false);
  }

  private showBubble(npc: Npc, message: string): void {
    npc.bubble?.root.destroy();
    const text = this.scene.add
      .text(0, 0, message.length > 90 ? `${message.slice(0, 87)}…` : message, {
        fontFamily: "monospace",
        fontSize: "9px",
        color: "#2b2f46",
        wordWrap: { width: 124 },
        align: "left",
      })
      .setOrigin(0.5, 1);
    const w = Math.max(34, text.width + 12);
    const h = text.height + 10;
    const g = this.scene.add.graphics();
    g.fillStyle(0xf8f5ec, 1).lineStyle(2, 0x1d2136, 1);
    g.fillRoundedRect(-w / 2, -h - 4, w, h, 5).strokeRoundedRect(-w / 2, -h - 4, w, h, 5);
    g.fillTriangle(-4, -5, 4, -5, 0, 1).lineStyle(2, 0x1d2136, 1);
    text.setY(-9);
    const root = this.scene.add
      .container(npc.sprite.x, npc.sprite.y + BUBBLE_DY, [g, text])
      .setDepth(DEPTH.emote + 1)
      .setAlpha(0);
    this.scene.tweens.add({ targets: root, alpha: 1, duration: 140 });
    npc.bubble = { root, until: this.scene.time.now + BUBBLE_MS };
  }

  // ---- per-frame -------------------------------------------------------------
  update(): void {
    const now = this.scene.time.now;
    const dt = Math.min(this.scene.game.loop.delta, 50) / 1000;
    this.releaseArrival(now);

    for (const npc of this.npcs.values()) {
      this.followAttachments(npc, now);
      if (npc.phase === "queued") continue; // still outside
      if (npc.plan) this.stepAlong(npc, npc.plan, dt);
      else if (npc.phase === "settled" && npc.activity.kind === "idle" && now >= npc.nextWanderAt)
        this.wander(npc, now);
      this.applyDepth(npc);
    }
  }

  /** The label, emote and bubble ride along with the sprite; a bubble also expires. */
  private followAttachments(npc: Npc, now: number): void {
    npc.label.setPosition(npc.sprite.x, npc.sprite.y + LABEL_DY);
    npc.emote?.setPosition(npc.sprite.x, npc.sprite.y + EMOTE_DY + (npc.emoteBob?.dy ?? 0));
    const bubble = npc.bubble;
    if (!bubble) return;
    bubble.root.setPosition(npc.sprite.x, npc.sprite.y + BUBBLE_DY);
    if (now <= bubble.until) return;
    npc.bubble = undefined;
    this.scene.tweens.add({
      targets: bubble.root,
      alpha: 0,
      duration: 180,
      onComplete: () => bubble.root.destroy(),
    });
  }

  /** One frame along the plan; the arrival hook runs once the last waypoint is reached. */
  private stepAlong(npc: Npc, plan: WalkPlan, dt: number): void {
    const waypoint = plan.path[0];
    if (!waypoint) {
      npc.plan = null;
      this.applyLook(npc);
      plan.onArrive?.(); // an arrival pose (POI facing / sitting) overrides the default look
      return;
    }
    const step = stepToward(npc.sprite, waypoint, NPC_SPEED * dt);
    if (step.kind === "arrive") {
      npc.sprite.setPosition(waypoint.x, waypoint.y);
      plan.path.shift();
      return;
    }
    npc.sprite.x += step.dx;
    npc.sprite.y += step.dy;
    npc.sprite.play(npc.anims.walk[step.facing], true);
  }

  /** The idle life: a chat with a colleague, a point of interest, or a stroll. */
  private wander(npc: Npc, now: number): void {
    npc.nextWanderAt = now + 5000 + Math.random() * 9000;
    if (this.startIdleChat(npc) || this.visitPoi(npc)) return;
    const home = npc.seat ?? this.door;
    const spot =
      randomFloor(this.grid, npc.sprite, 180) ??
      randomFloor(this.grid, { x: home.x, y: home.y + 128 }, 240);
    if (spot && Math.random() < 0.85) this.walkTo(npc, spot);
  }

  /** Wander flavor: walk to a point of interest, face it (or sit) for a bit. */
  private visitPoi(npc: Npc): boolean {
    if (this.pois.length === 0 || Math.random() > 0.35) return false;
    const poi = this.pois[Math.floor(Math.random() * this.pois.length)];
    if (!poi) return false;
    // don't crowd an occupied spot
    for (const other of this.npcs.values()) {
      if (other.id !== npc.id && Math.hypot(other.sprite.x - poi.x, other.sprite.y - poi.y) < 10)
        return false;
    }
    const dwell = 2500 + Math.random() * 4000;
    return this.walkTo(npc, poi, () => {
      npc.nextWanderAt = this.scene.time.now + dwell + 800;
      if (poi.sit) {
        // the chair is furniture the walker stops beside; the sitter is placed on it
        npc.sprite.setPosition(poi.x, poi.y);
        npc.sprite.play(npc.anims.sit[poi.sit], true);
      } else this.standFacing(npc, poi.face);
      npc.pendingTimer = this.scene.time.delayedCall(dwell, () => {
        if (!npc.plan && npc.activity.kind === "idle") {
          this.standFacing(npc, "down");
          this.stepAway(npc);
        }
      });
    });
  }

  private startIdleChat(npc: Npc): boolean {
    if (Math.random() > 0.68) return false;
    const target = this.pickIdlePartner(npc);
    if (!target) return false;
    const nearTarget = randomFloor(this.grid, target.sprite, 48) ?? besideOf(target.sprite);

    return this.walkTo(npc, nearTarget, () => {
      this.showIdleBubble(npc);
      if (target.activity.kind === "idle") this.showIdleBubble(target);
      npc.pendingTimer = this.scene.time.delayedCall(1700 + Math.random() * 1800, () => {
        if (!npc.plan && npc.activity.kind === "idle") this.stepAway(npc);
      });
    });
  }

  private pickIdlePartner(npc: Npc): Npc | null {
    const choices: Npc[] = [];
    for (const candidate of this.npcs.values()) {
      if (
        candidate.id !== npc.id &&
        candidate.phase === "settled" &&
        candidate.activity.kind === "idle"
      )
        choices.push(candidate);
    }
    if (choices.length === 0) return null;
    return choices[Math.floor(Math.random() * choices.length)] ?? null;
  }

  private stepAway(npc: Npc): void {
    const spot = randomFloor(this.grid, npc.sprite, 96);
    if (spot) this.walkTo(npc, spot);
  }

  private showIdleBubble(npc: Npc): void {
    const line = IDLE_CHAT_LINES[Math.floor(Math.random() * IDLE_CHAT_LINES.length)] ?? "ok";
    this.showBubble(npc, line);
  }

  /**
   * Remove one NPC (an employee was released). Through the door when they are
   * in the office to walk out of; otherwise they are simply gone. Either way
   * their desk is free for whoever was standing.
   */
  despawn(employeeId: string, passage: Passage): void {
    const npc = this.npcs.get(employeeId);
    if (!npc) return;
    this.roster.delete(employeeId);
    this.replan();
    if (passage === "door" && npc.phase === "settled") this.leave(npc);
    else this.destroyNpc(npc);
  }

  private destroyNpc(npc: Npc): void {
    this.npcs.delete(npc.id);
    this.arrivals = this.arrivals.filter((id) => id !== npc.id);
    npc.pendingTimer?.remove();
    // a fade or bob still running would keep driving a destroyed object
    this.scene.tweens.killTweensOf(npc.sprite);
    if (npc.emoteBob) this.scene.tweens.killTweensOf(npc.emoteBob);
    npc.bubble?.root.destroy();
    npc.emote?.destroy();
    npc.label.destroy();
    npc.sprite.destroy();
    unloadCharacter(this.scene, npc.key);
  }

  destroy(): void {
    // deleting the current entry mid-iteration is defined for Map
    for (const npc of this.npcs.values()) this.destroyNpc(npc);
    this.roster.clear();
    this.seatPlan = new Map();
  }
}
