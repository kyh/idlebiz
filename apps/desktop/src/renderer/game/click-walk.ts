import type Phaser from "phaser";
import type { Dir } from "@/renderer/game/character-sheet";
import { DEPTH, WALK_SPEED } from "@/renderer/game/config";
import { facingToward, stepToward } from "@/renderer/game/movement";
import { findPath, type WalkGrid } from "@/shared/office-grid";
import type { PixelPoint } from "@/shared/office-layout-schema";

/** The player, as click-to-walk drives them. The scene keeps the sprite and the collision. */
export interface Walker {
  /** Where they stand, read live — the sprite itself will do. */
  readonly position: PixelPoint;
  /** Land exactly here: a waypoint is walkable by construction, so no collision test. */
  place(at: PixelPoint): void;
  /** Try to move by a delta; collision may allow less, or nothing at all. */
  move(dx: number, dy: number): void;
  /** Stand still, looking `dir`. */
  face(dir: Dir): void;
  /** Walk, animated, looking `dir`. */
  walk(dir: Dir): void;
}

/** The colleagues a click can land on — what the NPC manager answers about them. */
export interface Colleagues {
  interactAt(x: number, y: number): string | null;
  positionOf(employeeId: string): PixelPoint | null;
  inReach(employeeId: string, point: PixelPoint): boolean;
}

/**
 * Somewhere the player clicked, and why.
 *
 * `points` are the remaining waypoints; `index` is the one being walked to. `talkTo` is
 * set when the click landed on a colleague — we walk over and then start the conversation,
 * so clicking someone across the room means "go talk to them", not "go stand near them".
 */
interface Route {
  readonly points: readonly PixelPoint[];
  index: number;
  readonly talkTo: string | null;
}

/**
 * Click to walk there; click a colleague to go talk to them; click one you're already
 * standing next to and you just talk.
 *
 * Same contract as the web app's office-life card (apps/web/src/app/office-life.tsx):
 * a marker drops where you clicked and clears when you arrive. The difference is that
 * this office has furniture in it, so we path around it rather than slide through.
 */
export class ClickWalk {
  private route: Route | null = null;
  private marker?: Phaser.GameObjects.Graphics;

  constructor(
    private scene: Phaser.Scene,
    private grid: WalkGrid,
    private walker: Walker,
    private colleagues: Colleagues,
    private talk: (employeeId: string) => void,
  ) {}

  onPointerDown(to: PixelPoint): void {
    const { walker, colleagues } = this;
    const clicked = colleagues.interactAt(to.x, to.y);
    if (clicked) {
      // near enough to talk from where we stand: don't make them walk first
      if (colleagues.inReach(clicked, walker.position)) {
        this.cancel();
        this.faceToward(colleagues.positionOf(clicked) ?? to);
        this.talk(clicked);
        return;
      }
      const at = colleagues.positionOf(clicked);
      if (at) {
        this.start(at, clicked);
        return;
      }
    }
    this.start(to, null);
  }

  /** One frame along the route. False when there is no route, or it just ended. */
  update(dt: number): boolean {
    const route = this.route;
    if (!route) return false;
    if (this.follow(route, dt)) return true;
    this.arrive(route);
    return false;
  }

  cancel(): void {
    this.route = null;
    this.marker?.destroy();
    this.marker = undefined;
  }

  /**
   * Walk to `to`, then talk to `talkTo` if set.
   *
   * findPath already snaps an unwalkable goal to the nearest floor, so clicking a desk
   * walks you up to it rather than doing nothing — which is what a player means by it.
   */
  private start(to: PixelPoint, talkTo: string | null): void {
    const points = findPath(this.grid, this.walker.position, to);
    if (!points || points.length === 0) {
      this.cancel(); // nowhere to stand over there; don't leave a marker lying
      return;
    }
    this.route = { points, index: 0, talkTo };
    const goal = points[points.length - 1];
    if (goal) this.mark(goal);
  }

  /** Advance along the route. Returns false when there's no further to go. */
  private follow(route: Route, dt: number): boolean {
    const point = route.points[route.index];
    if (!point) return false;
    const { walker } = this;
    const step = stepToward(walker.position, point, WALK_SPEED * dt);
    if (step.kind === "arrive") {
      walker.place(point);
      route.index += 1;
      return route.index < route.points.length;
    }
    const { x: wasX, y: wasY } = walker.position;
    walker.move(step.dx, step.dy);
    // the path is walkable by construction, so being stuck means the world moved under
    // us (a layout swap, a body wedged on a corner). Give up rather than shove forever.
    if (walker.position.x === wasX && walker.position.y === wasY) return false;
    walker.walk(step.facing);
    return true;
  }

  private arrive(route: Route): void {
    this.cancel();
    const { talkTo } = route;
    if (!talkTo) return;
    // they may have wandered off mid-walk; only talk if they're actually still here
    if (!this.colleagues.inReach(talkTo, this.walker.position)) return;
    this.faceToward(this.colleagues.positionOf(talkTo) ?? this.walker.position);
    this.talk(talkTo);
  }

  private faceToward(point: PixelPoint): void {
    const { position } = this.walker;
    this.walker.face(facingToward(point.x - position.x, point.y - position.y));
  }

  /** A flat diamond where you clicked — flat so it reads as lying on the floor. */
  private mark(at: PixelPoint): void {
    this.marker?.destroy();
    const g = this.scene.add.graphics();
    // above every floor decal, below anyone standing on it
    g.setDepth(DEPTH.entityBase - 1);
    g.lineStyle(2, 0x86c0ee, 1);
    g.beginPath();
    g.moveTo(at.x, at.y - 4);
    g.lineTo(at.x + 7, at.y);
    g.lineTo(at.x, at.y + 4);
    g.lineTo(at.x - 7, at.y);
    g.closePath();
    g.strokePath();
    this.marker = g;
  }
}
