// The idle life of an employee with nothing to do: a chat with an idle colleague, a
// point of interest, a stroll, or a real team-chat message walked over to whoever it
// was for, and stepping away once the moment is over. It sees the office and its
// people, never the NPC manager.
import type Phaser from "phaser";
import type { Dir, SitSide } from "@/renderer/game/character-sheet";
import { randomFloor } from "@/renderer/game/movement";
import { standFacing, walkTo } from "@/renderer/game/npc";
import type { Npc } from "@/renderer/game/npc";
import { BUBBLE_MS } from "@/renderer/game/npc-attachments";
import type { PixelPoint } from "@/renderer/game/office-layout";
import type { WalkGrid } from "@/shared/office-grid";

/** A point of interest idle employees visit: stand at (x,y) facing `face`,
 *  or sit (break-room chair) playing the matching sit animation. */
export interface Poi {
  readonly x: number;
  readonly y: number;
  readonly face: Dir;
  readonly sit?: SitSide;
}

/** What the idle life sees of the office. */
interface IdleWorld {
  readonly clock: Phaser.Time.Clock;
  readonly grid: WalkGrid;
  readonly door: PixelPoint;
  readonly pois: readonly Poi[];
  /** Every employee the office holds, whatever their phase: anyone near a POI crowds it. */
  readonly everyone: () => Iterable<Npc>;
}

const IDLE_CHAT_LINES: readonly string[] = [
  "quick sync",
  "looks good",
  "ship it",
  "coffee?",
  "backlog?",
];

/** Where to stand to talk to someone: just off their right shoulder. */
const besideOf = (at: PixelPoint): PixelPoint => ({ x: at.x + 26, y: at.y + 6 });

const showIdleBubble = (npc: Npc): void => {
  const line = IDLE_CHAT_LINES[Math.floor(Math.random() * IDLE_CHAT_LINES.length)] ?? "ok";
  npc.attachments.say(line);
};

export class IdleLife {
  private readonly world: IdleWorld;

  constructor(world: IdleWorld) {
    this.world = world;
  }

  /** The idle life: a chat with a colleague, a point of interest, or a stroll. */
  wander(npc: Npc, now: number): void {
    npc.nextWanderAt = now + 5000 + Math.random() * 9000;
    if (this.startIdleChat(npc) || this.visitPoi(npc)) {
      return;
    }
    const { grid } = this.world;
    const home = npc.seat ?? this.world.door;
    const spot =
      randomFloor(grid, npc.sprite, 180) ?? randomFloor(grid, { x: home.x, y: home.y + 128 }, 240);
    if (spot && Math.random() < 0.85) {
      walkTo(npc, grid, spot);
    }
  }

  /**
   * Walk a real team-chat message to the teammate it was for (else the first colleague
   * at their day), deliver it as a speech bubble, then head off.
   */
  deliver(npc: Npc, message: string, to: string | null): void {
    const settled = [...this.world.everyone()].filter(
      (n) => n.phase === "settled" && n.id !== npc.id,
    );
    const target = (to === null ? undefined : settled.find((n) => n.id === to)) ?? settled[0];

    // already busy walking (or nobody to visit) → just speak in place
    if (!target || npc.plan) {
      npc.attachments.say(message);
      return;
    }

    const ok = walkTo(npc, this.world.grid, besideOf(target.sprite), () => {
      npc.attachments.say(message);
      npc.pendingTimer = this.world.clock.delayedCall(BUBBLE_MS - 400, () => {
        if (!npc.plan && npc.activity.kind === "idle") {
          this.stepAway(npc);
        }
      });
    });
    if (!ok) {
      npc.attachments.say(message);
    }
  }

  private stepAway(npc: Npc): void {
    const spot = randomFloor(this.world.grid, npc.sprite, 96);
    if (spot) {
      walkTo(npc, this.world.grid, spot);
    }
  }

  /** Wander flavor: walk to a point of interest, face it (or sit) for a bit. */
  private visitPoi(npc: Npc): boolean {
    const { pois, clock } = this.world;
    if (pois.length === 0 || Math.random() > 0.35) {
      return false;
    }
    const poi = pois[Math.floor(Math.random() * pois.length)];
    if (!poi) {
      return false;
    }
    // don't crowd an occupied spot
    for (const other of this.world.everyone()) {
      if (other.id !== npc.id && Math.hypot(other.sprite.x - poi.x, other.sprite.y - poi.y) < 10) {
        return false;
      }
    }
    const dwell = 2500 + Math.random() * 4000;
    return walkTo(npc, this.world.grid, poi, () => {
      npc.nextWanderAt = clock.now + dwell + 800;
      if (poi.sit) {
        // the chair is furniture the walker stops beside; the sitter is placed on it
        npc.sprite.setPosition(poi.x, poi.y);
        npc.sprite.play(npc.anims.sit[poi.sit], true);
      } else {
        standFacing(npc, poi.face);
      }
      npc.pendingTimer = clock.delayedCall(dwell, () => {
        if (!npc.plan && npc.activity.kind === "idle") {
          standFacing(npc, "down");
          this.stepAway(npc);
        }
      });
    });
  }

  private startIdleChat(npc: Npc): boolean {
    if (Math.random() > 0.68) {
      return false;
    }
    const target = this.pickIdlePartner(npc);
    if (!target) {
      return false;
    }
    const nearTarget = randomFloor(this.world.grid, target.sprite, 48) ?? besideOf(target.sprite);

    return walkTo(npc, this.world.grid, nearTarget, () => {
      showIdleBubble(npc);
      if (target.activity.kind === "idle") {
        showIdleBubble(target);
      }
      npc.pendingTimer = this.world.clock.delayedCall(1700 + Math.random() * 1800, () => {
        if (!npc.plan && npc.activity.kind === "idle") {
          this.stepAway(npc);
        }
      });
    });
  }

  private pickIdlePartner(npc: Npc): Npc | null {
    const choices: Npc[] = [];
    for (const candidate of this.world.everyone()) {
      if (
        candidate.id !== npc.id &&
        candidate.phase === "settled" &&
        candidate.activity.kind === "idle"
      ) {
        choices.push(candidate);
      }
    }
    if (choices.length === 0) {
      return null;
    }
    return choices[Math.floor(Math.random() * choices.length)] ?? null;
  }
}
