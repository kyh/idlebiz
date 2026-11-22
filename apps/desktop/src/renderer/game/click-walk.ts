import type Phaser from "phaser";
import { WALK_SPEED } from "@/renderer/game/config";
import { facingToward, stepToward } from "@/renderer/game/movement";
import { DEPTH } from "@/renderer/game/office-depth";
import { findPath } from "@/renderer/game/office-grid";
import type { WalkGrid } from "@/renderer/game/office-grid";
import type { PixelPoint } from "@/renderer/game/office-layout-schema";
import type { Dir } from "@repo/domain/character-frame";

/** The player, as click-to-walk drives them. The scene keeps the sprite and the collision. */
export interface Walker {
  /** Where they stand, read live — the sprite itself will do. */
  readonly position: PixelPoint;
  /** Land exactly here: a waypoint is walkable by construction, so no collision test. */
  place: (at: PixelPoint) => void;
  /** Try to move by a delta; collision may allow less, or nothing at all. */
  move: (dx: number, dy: number) => void;
  /** Stand still, looking `dir`. */
  face: (dir: Dir) => void;
  /** Walk, animated, looking `dir`. */
  walk: (dir: Dir) => void;
}

/** The colleagues a click can land on — what the NPC manager answers about them. */
export interface Colleagues {
  interactAt: (x: number, y: number) => string | null;
  positionOf: (employeeId: string) => PixelPoint | null;
  inReach: (employeeId: string, point: PixelPoint) => boolean;
}

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
  private marker?: Phaser.GameObjects.Graphics | undefined;
  private readonly scene: Phaser.Scene;
  private readonly grid: WalkGrid;
  private readonly walker: Walker;
  private readonly colleagues: Colleagues;
  private readonly talk: (employeeId: string) => void;

  constructor(
    scene: Phaser.Scene,
    grid: WalkGrid,
    walker: Walker,
    colleagues: Colleagues,
    talk: (employeeId: string) => void,
  ) {
    this.scene = scene;
    this.grid = grid;
    this.walker = walker;
    this.colleagues = colleagues;
    this.talk = talk;
  }

  onPointerDown(to: PixelPoint) {
    const { walker, colleagues } = this;
    const clicked = colleagues.interactAt(to.x, to.y);

    if (clicked) {
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
  update(dt: number) {
    const { route } = this;

    if (!route) {
      return false;
    }

    if (this.follow(route, dt)) {
      return true;
    }

    this.arrive(route);

    return false;
  }

  cancel() {
    this.route = null;
    this.marker?.destroy();
    this.marker = undefined;
  }

  private start(to: PixelPoint, talkTo: string | null) {
    const points = findPath(this.grid, this.walker.position, to);

    if (!points || points.length === 0) {
      this.cancel();

      return;
    }

    this.route = { index: 0, points, talkTo };
    const goal = points.at(-1);

    if (goal) {
      this.mark(goal);
    }
  }

  private follow(route: Route, dt: number) {
    const point = route.points[route.index];

    if (!point) {
      return false;
    }

    const { walker } = this;
    const step = stepToward(walker.position, point, WALK_SPEED * dt);

    if (step.kind === "arrive") {
      walker.place(point);
      route.index += 1;

      return route.index < route.points.length;
    }

    const { x: wasX, y: wasY } = walker.position;
    walker.move(step.dx, step.dy);

    if (walker.position.x === wasX && walker.position.y === wasY) {
      return false;
    }

    walker.walk(step.facing);

    return true;
  }

  private arrive(route: Route) {
    this.cancel();
    const { talkTo } = route;

    if (!talkTo) {
      return;
    }

    if (!this.colleagues.inReach(talkTo, this.walker.position)) {
      return;
    }

    this.faceToward(this.colleagues.positionOf(talkTo) ?? this.walker.position);
    this.talk(talkTo);
  }

  private faceToward(point: PixelPoint) {
    const { position } = this.walker;
    this.walker.face(facingToward(point.x - position.x, point.y - position.y));
  }

  private mark(at: PixelPoint) {
    this.marker?.destroy();
    const g = this.scene.add.graphics();
    g.setDepth(DEPTH.entityBase - 1);
    g.lineStyle(2, 0x86_c0_ee, 1);
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
