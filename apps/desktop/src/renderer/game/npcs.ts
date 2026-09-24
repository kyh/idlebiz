import type Phaser from "phaser";
import {
  characterAnims,
  CHAR_ORIGIN_X,
  CHAR_ORIGIN_Y,
  idleFrame,
} from "@/renderer/game/character-sheet";
import { loadCharacter, unloadCharacter } from "@/renderer/game/characters";
import { randomFloor } from "@/renderer/game/movement";
import {
  applyDepth,
  applyLook,
  atSeat,
  clearPending,
  sitDown,
  stepAlong,
  walkTo,
} from "@/renderer/game/npc";
import type { Npc, Seat } from "@/renderer/game/npc";
import { NpcAttachments } from "@/renderer/game/npc-attachments";
import { IdleLife } from "@/renderer/game/npc-idle";
import type { Poi } from "@/renderer/game/npc-idle";
import type { Activity } from "@/renderer/game/npc-look";
import type { PixelPoint } from "@/renderer/game/office-layout";
import { planSeats } from "@/renderer/game/office-placement";
import type { SeatPlan } from "@/renderer/game/office-placement";
import { DEFAULT_WORK_POSE } from "@/renderer/game/office-poses";
import type { WorkPose } from "@/renderer/game/office-poses";
import type { Employee } from "@/shared/domain";
import type { WalkGrid } from "@/shared/office-grid";

export type NpcState = Activity["kind"];

/** How an employee joins or leaves: already in place (boot), or through the door (live). */
export type Passage = "settled" | "door";

const INTERACT_RADIUS = 38;
/** Gap between two hires walking through the door — a procession, not a spawn burst. */
const ARRIVAL_INTERVAL_MS = 480;
const FADE_MS = 220;
const HOVERABLE = { useHandCursor: true };

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
  private readonly npcs = new Map<string, Npc>();
  private readonly roster = new Map<string, Employee>();
  private seatPlan: SeatPlan = new Map();
  private arrivals: string[] = [];
  private nextArrivalAt = 0;
  // Phaser's loader is single-batch; serialize spawns so concurrent hires don't race it.
  private chain: Promise<void> = Promise.resolve();
  /** Released while their spawn was still queued in the chain: never let them in. */
  private readonly released = new Set<string>();
  // a restart reuses this scene: a spawn still queued must not land in the next one's office
  private disposed = false;
  private readonly scene: Phaser.Scene;
  private readonly seats: readonly Seat[];
  private readonly grid: WalkGrid;
  private readonly door: PixelPoint;
  private readonly idle: IdleLife;

  constructor(
    scene: Phaser.Scene,
    seats: readonly Seat[],
    grid: WalkGrid,
    pois: readonly Poi[],
    door: PixelPoint,
  ) {
    this.scene = scene;
    this.seats = seats;
    this.grid = grid;
    this.door = door;
    this.idle = new IdleLife({
      clock: scene.time,
      door,
      everyone: () => this.npcs.values(),
      grid,
      pois,
    });
  }

  spawn(emp: Employee, passage: Passage): Promise<void> {
    this.chain = this.spawnAfter(this.chain, emp, passage);
    return this.chain;
  }

  private async spawnAfter(
    previous: Promise<void>,
    emp: Employee,
    passage: Passage,
  ): Promise<void> {
    await previous;
    try {
      await this.doSpawn(emp, passage);
    } catch {
      // a failed spawn must not hold up the hires queued behind it
    }
  }

  private async doSpawn(emp: Employee, passage: Passage): Promise<void> {
    if (this.disposed || this.npcs.has(emp.id)) {
      return;
    }
    const key = `emp-${emp.id}`;
    await loadCharacter(this.scene, key, emp.spriteSeed);
    // textures are game-wide: the next scene's manager may already be drawing this key
    if (this.disposed) {
      return;
    }
    if (this.released.delete(emp.id)) {
      unloadCharacter(this.scene, key);
      return;
    }

    this.roster.set(emp.id, emp);
    const seat = this.seatFor(this.replan().get(emp.id));
    const start = passage === "settled" ? (seat ?? this.standingSpot()) : this.door;

    const sprite = this.scene.add
      .sprite(start.x, start.y, key, idleFrame("up"))
      .setOrigin(CHAR_ORIGIN_X, CHAR_ORIGIN_Y);
    // hoverable once they are actually in the room, not while queued unseen at the door
    if (passage === "settled") {
      sprite.setInteractive(HOVERABLE);
    }

    const npc: Npc = {
      activity: { kind: "idle" },
      anims: characterAnims(key),
      asking: false,
      // Who this is and what runs them: the roster is mixed, and nothing else in
      // the office says which CLI a colleague is.
      attachments: new NpcAttachments(this.scene, sprite, `${emp.name} · ${emp.runner}`),
      id: emp.id,
      key,
      nextWanderAt: this.scene.time.now + 4000 + Math.random() * 8000,
      phase: passage === "settled" ? "settled" : "queued",
      plan: null,
      seat,
      sprite,
    };
    this.npcs.set(emp.id, npc);
    if (passage === "door") {
      sprite.setAlpha(0);
      this.arrivals.push(emp.id);
    }
    this.setState(emp.id, emp.status);
    applyDepth(npc);
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
    const next = planSeats(this.seats.length, [...this.roster.values()], this.seatPlan);
    this.seatPlan = next;
    for (const [id, index] of next) {
      const npc = this.npcs.get(id);
      if (!npc) {
        continue;
      }
      const seat = this.seatFor(index);
      if (seat === npc.seat) {
        continue;
      }
      npc.seat = seat;
      if (npc.phase === "entering") {
        this.routeIn(npc);
      } else if (npc.phase === "settled" && npc.activity.kind !== "idle") {
        this.goToSeat(npc);
      }
    }
    return next;
  }

  /** Let the next hire in the queue through the door. */
  private releaseArrival(now: number): void {
    if (this.arrivals.length === 0 || now < this.nextArrivalAt) {
      return;
    }
    const id = this.arrivals.shift();
    const npc = id === undefined ? undefined : this.npcs.get(id);
    if (!npc) {
      return;
    }
    this.nextArrivalAt = now + ARRIVAL_INTERVAL_MS;
    npc.phase = "entering";
    npc.sprite.setPosition(this.door.x, this.door.y);
    npc.sprite.setInteractive(HOVERABLE);
    this.scene.tweens.add({ alpha: 1, duration: FADE_MS, targets: npc.sprite });
    // whatever they were asked or told while queued shows now
    applyLook(npc);
    this.routeIn(npc);
  }

  /** Walk from wherever they are to their seat (or a standing spot), then settle. */
  private routeIn(npc: Npc): void {
    const dest = npc.seat ?? this.standingSpot();
    if (!walkTo(npc, this.grid, dest, () => this.settle(npc))) {
      this.settle(npc);
    }
  }

  private settle(npc: Npc): void {
    npc.phase = "settled";
    npc.nextWanderAt = this.scene.time.now + 1500 + Math.random() * 3000;
    sitDown(npc);
  }

  /** Back to the desk — walking, or a snap when there is no way through. */
  private goToSeat(npc: Npc): void {
    const { seat } = npc;
    if (!seat || atSeat(npc)) {
      applyLook(npc);
      return;
    }
    if (!walkTo(npc, this.grid, seat, () => sitDown(npc))) {
      sitDown(npc);
    }
  }

  /** Out through the door. Their seat is already someone else's to claim. */
  private leave(npc: Npc): void {
    npc.phase = "leaving";
    clearPending(npc);
    npc.attachments.dismiss();
    npc.sprite.disableInteractive();
    const gone = (): void => {
      this.scene.tweens.add({
        alpha: 0,
        duration: FADE_MS,
        onComplete: () => this.destroyNpc(npc),
        targets: npc.sprite,
      });
    };
    if (!walkTo(npc, this.grid, this.door, gone)) {
      this.destroyNpc(npc);
    }
  }

  // ---- state ---------------------------------------------------------------
  setState(id: string, state: NpcState): void {
    const npc = this.npcs.get(id);
    if (!npc) {
      return;
    }
    npc.activity =
      state === "working" ? { kind: "working", pose: DEFAULT_WORK_POSE } : { kind: state };
    clearPending(npc);
    // idle: the run settled without a hanging question, or it was answered;
    // working: a new run, so whatever they asked last time has been dealt with
    if (state !== "blocked") {
      npc.asking = false;
    }
    if (state === "idle") {
      npc.nextWanderAt = this.scene.time.now + 700 + Math.random() * 1800;
      applyLook(npc);
      return;
    }
    // working / blocked employees belong at their computer
    if (npc.phase === "settled") {
      this.goToSeat(npc);
    } else {
      applyLook(npc);
    }
  }

  /** Work was queued for them: a blocked employee was answered, a working one carries on. */
  unblock(id: string): void {
    if (this.npcs.get(id)?.activity.kind === "blocked") {
      this.setState(id, "idle");
    }
  }

  /** Asks the steering loop dropped: only those still asking keep the "!". */
  unblockAllBut(asking: ReadonlySet<string>): void {
    for (const id of this.npcs.keys()) {
      if (!asking.has(id)) {
        this.unblock(id);
      }
    }
  }

  /** A tool call landed: hands on the keyboard, or eyes on the screen. */
  onTool(id: string, pose: WorkPose): void {
    const npc = this.npcs.get(id);
    if (!npc || npc.activity.kind !== "working") {
      return;
    }
    npc.activity = { kind: "working", pose };
    applyLook(npc);
  }

  /** They asked the founder something mid-run: raise the "!" now, not at run end. */
  onAsk(id: string): void {
    const npc = this.npcs.get(id);
    if (!npc) {
      return;
    }
    npc.asking = true;
    applyLook(npc);
  }

  /** Real team-chat staging: an idle employee walks the message over; anyone else says it where they are. */
  onChat(employeeId: string, message: string, to: string | null): void {
    const npc = this.npcs.get(employeeId);
    if (!npc || npc.phase === "queued") {
      return;
    }
    if (npc.phase === "settled" && npc.activity.kind === "idle") {
      this.idle.deliver(npc, message, to);
    } else {
      npc.attachments.say(message);
    }
  }

  /** Employees you can walk up to: everyone who has actually come through the door. */
  private inRoom(): Npc[] {
    return [...this.npcs.values()].filter((n) => n.phase !== "queued");
  }

  /** Returns the employee id whose NPC is nearest the faced point (within range). */
  interactAt(px: number, py: number): string | null {
    let best: { id: string; d: number } | null = null;
    for (const npc of this.inRoom()) {
      const d = Math.hypot(npc.sprite.x - px, npc.sprite.y - py);
      if (d <= INTERACT_RADIUS && (!best || d < best.d)) {
        best = { d, id: npc.id };
      }
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

  // ---- per-frame -------------------------------------------------------------
  update(): void {
    const { now } = this.scene.time;
    const dt = Math.min(this.scene.game.loop.delta, 50) / 1000;
    this.releaseArrival(now);

    for (const npc of this.npcs.values()) {
      npc.attachments.follow(now);
      if (npc.phase === "queued") {
        continue;
      }
      if (npc.plan) {
        stepAlong(npc, npc.plan, dt);
      } else if (
        npc.phase === "settled" &&
        npc.activity.kind === "idle" &&
        now >= npc.nextWanderAt
      ) {
        this.idle.wander(npc, now);
      }
      applyDepth(npc);
    }
  }

  /**
   * Remove one NPC (an employee was released). Through the door when they are
   * in the office to walk out of; otherwise they are simply gone. Either way
   * their desk is free for whoever was standing.
   */
  despawn(employeeId: string, passage: Passage): void {
    const npc = this.npcs.get(employeeId);
    if (!npc) {
      this.released.add(employeeId);
      return;
    }
    this.roster.delete(employeeId);
    this.replan();
    if (passage === "door" && npc.phase === "settled") {
      this.leave(npc);
    } else {
      this.destroyNpc(npc);
    }
  }

  private destroyNpc(npc: Npc): void {
    this.npcs.delete(npc.id);
    this.arrivals = this.arrivals.filter((id) => id !== npc.id);
    npc.pendingTimer?.remove();
    // a fade or bob still running would keep driving a destroyed object
    this.scene.tweens.killTweensOf(npc.sprite);
    npc.attachments.destroy();
    npc.sprite.destroy();
    unloadCharacter(this.scene, npc.key);
  }

  destroy(): void {
    this.disposed = true;
    // deleting the current entry mid-iteration is defined for Map
    for (const npc of this.npcs.values()) {
      this.destroyNpc(npc);
    }
    this.roster.clear();
    this.released.clear();
    this.seatPlan = new Map();
  }
}
