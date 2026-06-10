import Phaser from "phaser";
import { DEPTH } from "@/renderer/game/config";
import { loadCharacter, ensureWalkAnims, idleFrame, type Dir } from "@/renderer/game/characters";
import type { Employee } from "@/shared/domain";

export type NpcState = "idle" | "working" | "blocked";

/** A desk seat (px) an employee occupies. Owned by OfficeScene, sized to the active tier. */
export interface Seat {
  readonly x: number;
  readonly y: number;
}

/** Pathfinding services the scene provides (BFS over its collision grid). */
export interface PathProvider {
  /** Waypoints (px) from → to, or null if unreachable. */
  findPath(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): Array<{ x: number; y: number }> | null;
  /** A random walkable point within radius of (x, y), or null. */
  randomFloor(x: number, y: number, radius: number): { x: number; y: number } | null;
}

interface WalkPlan {
  path: Array<{ x: number; y: number }>;
  onArrive?: () => void;
}

interface Bubble {
  root: Phaser.GameObjects.Container;
  until: number;
}

interface Npc {
  id: string;
  name: string;
  key: string;
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  emote?: Phaser.GameObjects.Sprite;
  bubble?: Bubble;
  seat: Seat;
  state: NpcState;
  plan: WalkPlan | null;
  nextWanderAt: number;
  pendingTimer?: Phaser.Time.TimerEvent;
}

const EMOTE_FRAME: Record<"alert" | "think", number> = { alert: 0, think: 1 };
const NPC_SPEED = 64; // px/s
const INTERACT_RADIUS = 38;
const BUBBLE_MS = 3200;

/** Hired employees as living NPCs: they sit to work, wander when idle, walk to
 *  teammates to deliver real team-chat messages, and raise "!" when blocked. */
export class NpcManager {
  private npcs = new Map<string, Npc>();
  // Phaser's loader is single-batch; serialize spawns so concurrent hires don't race it.
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private scene: Phaser.Scene,
    private seats: ReadonlyArray<Seat>,
    private paths: PathProvider,
  ) {}

  size(): number {
    return this.npcs.size;
  }

  spawn(emp: Employee): Promise<void> {
    this.chain = this.chain.then(() => this.doSpawn(emp)).catch(() => {});
    return this.chain;
  }

  private async doSpawn(emp: Employee): Promise<void> {
    if (this.npcs.has(emp.id) || this.seats.length === 0) return;
    const key = `emp-${emp.id}`;
    await loadCharacter(this.scene, key, emp.spriteSeed);
    ensureWalkAnims(this.scene, key);

    const seat = this.seats[emp.deskIndex % this.seats.length];
    if (!seat) return;

    const sprite = this.scene.add.sprite(seat.x, seat.y, key, idleFrame("up")).setOrigin(0.5, 0.82);
    sprite.setDepth(DEPTH.entityBase + seat.y);

    const label = this.scene.add
      .text(seat.x, seat.y - 52, emp.name, {
        fontFamily: "monospace",
        fontSize: "10px",
        color: "#ffffff",
        backgroundColor: "#000000aa",
      })
      .setOrigin(0.5, 1)
      .setPadding(3, 1, 3, 1)
      .setDepth(DEPTH.emote);

    const npc: Npc = {
      id: emp.id,
      name: emp.name,
      key,
      sprite,
      label,
      seat,
      state: "idle",
      plan: null,
      nextWanderAt: this.scene.time.now + 4000 + Math.random() * 8000,
    };
    this.npcs.set(emp.id, npc);
    this.setState(emp.id, emp.status === "working" ? "working" : "idle");
  }

  // ---- state ---------------------------------------------------------------
  setState(id: string, state: NpcState): void {
    const npc = this.npcs.get(id);
    if (!npc) return;
    npc.state = state;
    if (state === "blocked") this.showEmote(npc, EMOTE_FRAME.alert);
    else this.clearEmote(npc);
    // working/blocked employees head back to their desk
    if (state !== "idle" && !npc.plan && !this.atSeat(npc))
      this.walkTo(npc, npc.seat.x, npc.seat.y);
    if (!npc.plan) this.applySeatedLook(npc);
  }

  private atSeat(npc: Npc): boolean {
    return Math.hypot(npc.sprite.x - npc.seat.x, npc.sprite.y - npc.seat.y) < 4;
  }

  private applySeatedLook(npc: Npc): void {
    const upAnim = `${npc.key}-walk-up`;
    if (npc.state === "working" && this.atSeat(npc)) {
      if (npc.sprite.anims.currentAnim?.key !== upAnim || !npc.sprite.anims.isPlaying)
        npc.sprite.play(upAnim, true);
    } else {
      npc.sprite.anims.stop();
      npc.sprite.setFrame(idleFrame("up"));
    }
  }

  // ---- movement --------------------------------------------------------------
  private walkTo(npc: Npc, x: number, y: number, onArrive?: () => void): boolean {
    const path = this.paths.findPath(npc.sprite.x, npc.sprite.y, x, y);
    if (!path || path.length === 0) return false;
    npc.plan = { path, onArrive };
    return true;
  }

  /** Real team-chat staging: walk to the named teammate (or just speak in place),
   *  deliver the message as a speech bubble, then head home. */
  onChat(employeeId: string, message: string, targetName: string | null): void {
    const npc = this.npcs.get(employeeId);
    if (!npc) return;

    const target =
      (targetName &&
        [...this.npcs.values()].find(
          (n) => n.id !== employeeId && n.name.toLowerCase() === targetName.toLowerCase(),
        )) ||
      [...this.npcs.values()].find((n) => n.id !== employeeId);

    // already busy walking (or nobody to visit) → just speak in place
    if (!target || npc.plan) {
      this.showBubble(npc, message);
      return;
    }

    const ok = this.walkTo(npc, target.seat.x + 26, target.seat.y + 6, () => {
      this.showBubble(npc, message);
      npc.pendingTimer = this.scene.time.delayedCall(BUBBLE_MS - 400, () => {
        this.walkTo(npc, npc.seat.x, npc.seat.y);
      });
    });
    if (!ok) this.showBubble(npc, message);
  }

  /** Returns the employee id whose NPC is nearest the faced point (within range). */
  interactAt(px: number, py: number): string | null {
    let best: { id: string; d: number } | null = null;
    for (const npc of this.npcs.values()) {
      const d = Math.hypot(npc.sprite.x - px, npc.sprite.y - py);
      if (d <= INTERACT_RADIUS && (!best || d < best.d)) best = { id: npc.id, d };
    }
    return best?.id ?? null;
  }

  // ---- visuals ---------------------------------------------------------------
  private showEmote(npc: Npc, frame: number): void {
    if (!npc.emote) {
      const e = this.scene.add
        .sprite(npc.sprite.x, npc.sprite.y - 58, "emotes", frame)
        .setDepth(DEPTH.emote);
      this.scene.tweens.add({
        targets: e,
        y: "-=4",
        duration: 480,
        yoyo: true,
        repeat: -1,
        ease: "Sine.InOut",
      });
      npc.emote = e;
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
      .container(npc.sprite.x, npc.sprite.y - 56, [g, text])
      .setDepth(DEPTH.emote + 1)
      .setAlpha(0);
    this.scene.tweens.add({ targets: root, alpha: 1, duration: 140 });
    npc.bubble = { root, until: this.scene.time.now + BUBBLE_MS };
  }

  // ---- per-frame -------------------------------------------------------------
  update(): void {
    const now = this.scene.time.now;
    const dt = Math.min(this.scene.game.loop.delta, 50) / 1000;

    for (const npc of this.npcs.values()) {
      // follow attachments
      npc.label.setPosition(npc.sprite.x, npc.sprite.y - 52);
      npc.emote?.setPosition(npc.sprite.x, npc.emote.y); // x follows; y owned by tween
      if (npc.emote) npc.emote.x = npc.sprite.x;
      if (npc.bubble) {
        npc.bubble.root.setPosition(npc.sprite.x, npc.sprite.y - 56);
        if (now > npc.bubble.until) {
          const b = npc.bubble.root;
          npc.bubble = undefined;
          this.scene.tweens.add({
            targets: b,
            alpha: 0,
            duration: 180,
            onComplete: () => b.destroy(),
          });
        }
      }

      // walking
      if (npc.plan) {
        const wp = npc.plan.path[0];
        if (!wp) {
          const done = npc.plan.onArrive;
          npc.plan = null;
          done?.();
          this.applySeatedLook(npc);
        } else {
          const dx = wp.x - npc.sprite.x;
          const dy = wp.y - npc.sprite.y;
          const dist = Math.hypot(dx, dy);
          const step = NPC_SPEED * dt;
          if (dist <= step) {
            npc.sprite.setPosition(wp.x, wp.y);
            npc.plan.path.shift();
          } else {
            npc.sprite.x += (dx / dist) * step;
            npc.sprite.y += (dy / dist) * step;
            const dir: Dir =
              Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
            npc.sprite.play(`${npc.key}-walk-${dir}`, true);
          }
        }
      } else if (npc.state === "idle" && now >= npc.nextWanderAt) {
        // idle wander: stroll somewhere nearby, pause, come home
        npc.nextWanderAt = now + 9000 + Math.random() * 14000;
        const spot = this.paths.randomFloor(npc.seat.x, npc.seat.y, 140);
        if (spot && Math.random() < 0.8) {
          this.walkTo(npc, spot.x, spot.y, () => {
            npc.pendingTimer = this.scene.time.delayedCall(1500 + Math.random() * 2500, () => {
              if (!npc.plan && npc.state === "idle") this.walkTo(npc, npc.seat.x, npc.seat.y);
            });
          });
        }
      }

      npc.sprite.setDepth(DEPTH.entityBase + npc.sprite.y);
    }
  }

  destroy(): void {
    for (const npc of this.npcs.values()) {
      npc.pendingTimer?.remove();
      npc.bubble?.root.destroy();
      npc.emote?.destroy();
      npc.label.destroy();
      npc.sprite.destroy();
    }
    this.npcs.clear();
  }
}
