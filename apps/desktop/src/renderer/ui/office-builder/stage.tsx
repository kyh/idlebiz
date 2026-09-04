import { memo, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { History } from "@/renderer/hooks/use-history";
import type { OfficeLayer, OfficePoi, OfficeSeat, PixelPoint } from "@/renderer/game/office-layout";
import type { Facing } from "@/shared/office-layout-schema";
import {
  cloneObject,
  contentBounds,
  flipTransform,
  makeObject,
  moveObject,
  paintOrder,
  setCollisionCell,
  srcForObject,
  type BuilderDoc,
  type EditableLayout,
  type EditableObject,
  type Tool,
} from "@/renderer/ui/office-builder/office-builder-model";

/** What the Place tool puts down on a click. */
export interface Placing {
  id: string;
  path?: string;
  layer?: OfficeLayer;
}

type Edit = Pick<History<BuilderDoc>, "live" | "mark" | "commit">;

/** How close a click must land to an existing marker to mean that marker. */
const MARKER_HIT_PX = 12;
const SELECTION_OUTLINE = "1px solid #34d399";
const NEXT_FACING = { up: "right", right: "down", down: "left", left: "up" } satisfies Record<
  Facing,
  Facing
>;
const FACING_GLYPH = { up: "↑", right: "→", down: "↓", left: "←" } satisfies Record<Facing, string>;

const near = (a: PixelPoint, b: PixelPoint): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y) < MARKER_HIT_PX;

/**
 * Markers share one gesture: click empty floor to add, click a marker to remove
 * it, ⇧click a marker to turn it (a rest chair's side, a POI's facing).
 */
function toggleSeat(
  seats: OfficeSeat[],
  role: OfficeSeat["role"],
  at: PixelPoint,
  turn: boolean,
): OfficeSeat[] {
  const i = seats.findIndex((s) => s.role === role && near(s, at));
  if (i < 0) {
    const added: OfficeSeat =
      role === "work" ? { role, x: at.x, y: at.y } : { role, x: at.x, y: at.y, sit: "left" };
    return [...seats, added];
  }
  const hit = seats[i];
  if (!turn || !hit || hit.role !== "rest") return seats.filter((_, j) => j !== i);
  return seats.map((s, j) =>
    j === i ? { ...hit, sit: hit.sit === "left" ? "right" : "left" } : s,
  );
}

function togglePoi(pois: OfficePoi[], at: PixelPoint, turn: boolean): OfficePoi[] {
  const i = pois.findIndex((p) => near(p, at));
  if (i < 0) return [...pois, { x: at.x, y: at.y, face: "up" }];
  const hit = pois[i];
  if (!turn || !hit) return pois.filter((_, j) => j !== i);
  return pois.map((p, j) => (j === i ? { ...hit, face: NEXT_FACING[hit.face] } : p));
}

const withLayout = (d: BuilderDoc, layout: EditableLayout): BuilderDoc =>
  layout === d.layout ? d : { ...d, layout };

const withSelection = (d: BuilderDoc, selection: readonly string[]): BuilderDoc => ({
  ...d,
  selection,
});

interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Drag {
  sx: number;
  sy: number;
  uids: readonly string[];
  dx: number;
  dy: number;
  /** An ⌥drag already put its clones down, so the stroke is on record. */
  marked: boolean;
}

/**
 * The canvas. Pointer gestures edit the document through `edit`; a drag moves
 * the selection with a CSS transform and only touches the document when the
 * pointer lifts, so the object layer never re-renders mid-gesture.
 */
export function Stage({
  doc,
  edit,
  tool,
  snap,
  zoom,
  placing,
  showCollision,
}: {
  doc: BuilderDoc;
  edit: Edit;
  tool: Tool;
  snap: number;
  zoom: number;
  placing: Placing | null;
  showCollision: boolean;
}) {
  const { layout, selection } = doc;
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const paintRef = useRef<0 | 1 | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const sortedObjects = useMemo(() => paintOrder(layout.objects), [layout.objects]);

  const snapTo = (v: number) => (snap > 1 ? Math.round(v / snap) * snap : Math.round(v));

  const worldFromEvent = (e: { clientX: number; clientY: number }): PixelPoint => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  };

  // hit-test: the object you'd see at (x,y) — the LAST one painted over it
  const hitTest = (x: number, y: number): EditableObject | null => {
    let best: EditableObject | null = null;
    for (const o of sortedObjects) {
      const b = contentBounds(o);
      const bx = o.x + b.x;
      const by = o.y + b.y;
      if (x < bx || y < by || x >= bx + b.w || y >= by + b.h) continue;
      best = o;
    }
    return best;
  };

  const setDragOffset = (dx: number, dy: number) => {
    const el = stageRef.current;
    if (!el) return;
    el.style.setProperty("--drag-x", `${dx}px`);
    el.style.setProperty("--drag-y", `${dy}px`);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = worldFromEvent(e);
    const sx = snapTo(p.x);
    const sy = snapTo(p.y);
    if (tool === "block" || tool === "clear") {
      const val: 0 | 1 = tool === "block" ? 1 : 0;
      paintRef.current = val;
      edit.mark(); // the whole paint stroke is one undo step
      const c = Math.floor(p.x / layout.cell);
      const r = Math.floor(p.y / layout.cell);
      edit.live((d) =>
        withLayout(d, {
          ...d.layout,
          collision: setCollisionCell(d.layout.collision, d.layout.cols, c, r, val),
        }),
      );
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === "place") {
      if (!placing) return;
      const obj = makeObject(placing.id, sx, sy, { path: placing.path, layer: placing.layer });
      // stay in Place mode so you can keep placing
      edit.commit((d) => ({
        layout: { ...d.layout, objects: [...d.layout.objects, obj] },
        selection: [obj.uid],
      }));
      return;
    }
    if (tool === "spawn") {
      edit.commit((d) => withLayout(d, { ...d.layout, spawn: { x: sx, y: sy } }));
      return;
    }
    if (tool === "door") {
      edit.commit((d) => withLayout(d, { ...d.layout, door: { x: sx, y: sy } }));
      return;
    }
    if (tool === "seat" || tool === "rest") {
      const role = tool === "seat" ? "work" : "rest";
      edit.commit((d) =>
        withLayout(d, {
          ...d.layout,
          seats: toggleSeat(d.layout.seats, role, { x: sx, y: sy }, e.shiftKey),
        }),
      );
      return;
    }
    if (tool === "poi") {
      edit.commit((d) =>
        withLayout(d, {
          ...d.layout,
          pois: togglePoi(d.layout.pois, { x: sx, y: sy }, e.shiftKey),
        }),
      );
      return;
    }
    // select / drag (clicking an object) or marquee (dragging empty space)
    const hit = hitTest(p.x, p.y);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!hit) {
      setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      return;
    }
    // a hit outside the selection selects just it; then the whole selection drags
    const group = selection.includes(hit.uid) ? selection : [hit.uid];
    if (e.altKey) {
      // Figma-style alt-drag: duplicate the selection and drag the copies
      const groupSet = new Set(group);
      const clones = layout.objects.filter((o) => groupSet.has(o.uid)).map((o) => cloneObject(o));
      edit.mark(); // the whole gesture (clone included) is one undo step
      edit.live((d) => ({
        layout: { ...d.layout, objects: [...d.layout.objects, ...clones] },
        selection: clones.map((o) => o.uid),
      }));
      dragRef.current = {
        sx: p.x,
        sy: p.y,
        uids: clones.map((o) => o.uid),
        dx: 0,
        dy: 0,
        marked: true,
      };
      return;
    }
    if (group !== selection) edit.live((d) => withSelection(d, group));
    dragRef.current = { sx: p.x, sy: p.y, uids: group, dx: 0, dy: 0, marked: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = worldFromEvent(e);
    const val = paintRef.current;
    if (val !== null) {
      const c = Math.floor(p.x / layout.cell);
      const r = Math.floor(p.y / layout.cell);
      edit.live((d) =>
        withLayout(d, {
          ...d.layout,
          collision: setCollisionCell(d.layout.collision, d.layout.cols, c, r, val),
        }),
      );
      return;
    }
    const drag = dragRef.current;
    if (drag) {
      drag.dx = snapTo(p.x - drag.sx);
      drag.dy = snapTo(p.y - drag.sy);
      setDragOffset(drag.dx, drag.dy);
      return;
    }
    setMarquee((m) => (m ? { ...m, x1: p.x, y1: p.y } : m));
  };

  const onPointerUp = () => {
    paintRef.current = null;
    const drag = dragRef.current;
    if (drag) {
      dragRef.current = null;
      setDragOffset(0, 0);
      const { dx, dy } = drag;
      if (dx !== 0 || dy !== 0) {
        const moving = new Set(drag.uids);
        const moved = (d: BuilderDoc): BuilderDoc =>
          withLayout(d, {
            ...d.layout,
            objects: d.layout.objects.map((o) =>
              moving.has(o.uid) ? moveObject(o, o.x + dx, o.y + dy) : o,
            ),
          });
        if (drag.marked) edit.live(moved);
        else edit.commit(moved);
      }
    }
    if (marquee) {
      const x0 = Math.min(marquee.x0, marquee.x1);
      const x1 = Math.max(marquee.x0, marquee.x1);
      const y0 = Math.min(marquee.y0, marquee.y1);
      const y1 = Math.max(marquee.y0, marquee.y1);
      // a click on empty space clears the selection; a box selects what it touches
      const hits =
        x1 - x0 > 3 || y1 - y0 > 3
          ? layout.objects
              .filter((o) => {
                const b = contentBounds(o);
                const bx = o.x + b.x;
                const by = o.y + b.y;
                return !(x1 < bx || x0 > bx + b.w || y1 < by || y0 > by + b.h);
              })
              .map((o) => o.uid)
          : [];
      edit.live((d) => withSelection(d, hits));
      setMarquee(null);
    }
  };

  return (
    <div
      ref={stageRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "relative",
        width: layout.width,
        height: layout.height,
        transform: `scale(${zoom})`,
        transformOrigin: "top left",
        imageRendering: "pixelated",
        outline: "1px solid #333",
        cursor: tool === "select" ? "default" : "crosshair",
      }}
    >
      <ObjectLayer objects={sortedObjects} selection={selection} />
      {showCollision ? <CollisionLayer layout={layout} /> : null}
      {layout.seats.map((s) => (
        <Marker
          key={`s-${s.x}-${s.y}`}
          kind={s.role}
          at={s}
          title={s.role === "work" ? "work seat" : `rest chair · sit ${s.sit}`}
        >
          {s.role === "rest" ? s.sit[0]?.toUpperCase() : null}
        </Marker>
      ))}
      {layout.pois.map((p) => (
        <Marker
          key={`p-${p.x}-${p.y}`}
          kind="poi"
          at={p}
          title={`point of interest · faces ${p.face}`}
        >
          {FACING_GLYPH[p.face]}
        </Marker>
      ))}
      <Marker kind="door" at={layout.door} title="door" />
      <Marker kind="spawn" at={layout.spawn} title="spawn" />
      {marquee ? (
        <div
          style={{
            position: "absolute",
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
            zIndex: 100003,
            background: "rgba(52,211,153,0.15)",
            border: SELECTION_OUTLINE,
            pointerEvents: "none",
          }}
        />
      ) : null}
    </div>
  );
}

/** The selection rides the stage's --drag-x/--drag-y during a drag; nothing else moves. */
const spriteTransform = (o: EditableObject, dragging: boolean): string | undefined => {
  const flip = flipTransform(o);
  if (!dragging) return flip;
  const ride = "translate(var(--drag-x, 0px), var(--drag-y, 0px))";
  return flip ? `${ride} ${flip}` : ride;
};

/** Every placed sprite in paint order. Memoised: a drag or a marquee must not redraw 700 images. */
const ObjectLayer = memo(function ObjectLayer({
  objects,
  selection,
}: {
  objects: readonly EditableObject[];
  selection: readonly string[];
}) {
  const picked = new Set(selection);
  return (
    <>
      {objects.map((o, i) => {
        const src = srcForObject(o);
        if (!src) return null;
        const dragging = picked.has(o.uid);
        return (
          <img
            key={o.uid}
            src={src}
            alt={o.id}
            draggable={false}
            style={{
              position: "absolute",
              left: o.x,
              top: o.y,
              zIndex: 10 + i,
              pointerEvents: "none",
              outline: dragging ? SELECTION_OUTLINE : "none",
              transform: spriteTransform(o, dragging),
            }}
            className="max-w-none [image-rendering:pixelated]"
          />
        );
      })}
    </>
  );
});

function CollisionLayer({ layout }: { layout: EditableLayout }) {
  const cells = useMemo(
    () => collisionCells(layout.collision, layout.cell),
    [layout.collision, layout.cell],
  );
  return (
    <>
      {cells.map((c) => (
        <div
          key={`c-${c.x}-${c.y}`}
          style={{
            position: "absolute",
            left: c.x,
            top: c.y,
            width: layout.cell,
            height: layout.cell,
            zIndex: 100000,
            background: "rgba(255,51,102,0.35)",
            pointerEvents: "none",
          }}
        />
      ))}
    </>
  );
}

function collisionCells(collision: readonly string[], cell: number): PixelPoint[] {
  const cells: PixelPoint[] = [];
  collision.forEach((row, r) => {
    for (let c = 0; c < row.length; c++)
      if (row[c] === "1") cells.push({ x: c * cell, y: r * cell });
  });
  return cells;
}

type MarkerKind = "work" | "rest" | "poi" | "door" | "spawn";
const MARKER_STYLE = {
  work: { background: "#38bdf8", borderRadius: 8, color: "#0b1a14", fontSize: 7, zIndex: 100001 },
  rest: { background: "#34d399", borderRadius: 2, color: "#0b1a14", fontSize: 7, zIndex: 100001 },
  poi: { background: "#f472b6", color: "#2a0a1c", fontSize: 8, zIndex: 100001 },
  door: { background: "#fb923c", outline: "1px solid #431407", zIndex: 100002 },
  spawn: { background: "#facc15", borderRadius: 8, zIndex: 100002 },
} satisfies Record<MarkerKind, CSSProperties>;

/** An 8×8 pin centred on a layout point: a seat, a point of interest, the door, the spawn. */
function Marker({
  kind,
  at,
  title,
  children,
}: {
  kind: MarkerKind;
  at: PixelPoint;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      title={title}
      style={{
        position: "absolute",
        left: at.x - 4,
        top: at.y - 4,
        width: 8,
        height: 8,
        lineHeight: "8px",
        textAlign: "center",
        pointerEvents: "none",
        ...MARKER_STYLE[kind],
      }}
    >
      {children}
    </div>
  );
}
