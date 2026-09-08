import { memo, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { History } from "@/renderer/hooks/use-history";
import type { OfficeLayer, OfficePoi, OfficeSeat, PixelPoint } from "@/renderer/game/office-layout";
import type { Facing } from "@/shared/office-layout-schema";
import {
  cloneObject,
  worldRect,
  flipTransform,
  makeObject,
  moveObject,
  paintOrder,
  setCollisionCell,
  srcForObject,
} from "@/renderer/ui/office-builder/office-builder-model";
import type {
  BuilderDoc,
  EditableLayout,
  EditableObject,
  Tool,
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
const NEXT_FACING = { down: "left", left: "up", right: "down", up: "right" } satisfies Record<
  Facing,
  Facing
>;
const FACING_GLYPH = { down: "↓", left: "←", right: "→", up: "↑" } satisfies Record<Facing, string>;

const near = (a: PixelPoint, b: PixelPoint): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y) < MARKER_HIT_PX;

/**
 * Markers share one gesture: click empty floor to add, click a marker to remove
 * it, ⇧click a marker to turn it (a rest chair's side, a POI's facing).
 */
const toggleSeat = (
  seats: OfficeSeat[],
  role: OfficeSeat["role"],
  at: PixelPoint,
  turn: boolean,
): OfficeSeat[] => {
  const i = seats.findIndex((s) => s.role === role && near(s, at));
  if (i === -1) {
    const added: OfficeSeat =
      role === "work" ? { role, x: at.x, y: at.y } : { role, sit: "left", x: at.x, y: at.y };
    return [...seats, added];
  }
  const hit = seats[i];
  if (!turn || !hit || hit.role !== "rest") {
    return seats.filter((_, j) => j !== i);
  }
  return seats.map((s, j) =>
    j === i ? { ...hit, sit: hit.sit === "left" ? "right" : "left" } : s,
  );
};

const togglePoi = (pois: OfficePoi[], at: PixelPoint, turn: boolean): OfficePoi[] => {
  const i = pois.findIndex((p) => near(p, at));
  if (i === -1) {
    return [...pois, { face: "up", x: at.x, y: at.y }];
  }
  const hit = pois[i];
  if (!turn || !hit) {
    return pois.filter((_, j) => j !== i);
  }
  return pois.map((p, j) => (j === i ? { ...hit, face: NEXT_FACING[hit.face] } : p));
};

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

/** The selection rides the stage's --drag-x/--drag-y during a drag; nothing else moves. */
const spriteTransform = (o: EditableObject, dragging: boolean): string | undefined => {
  const flip = flipTransform(o);
  if (!dragging) {
    return flip;
  }
  const ride = "translate(var(--drag-x, 0px), var(--drag-y, 0px))";
  return flip ? `${ride} ${flip}` : ride;
};

const ObjectLayerView = ({
  objects,
  selection,
}: {
  objects: readonly EditableObject[];
  selection: readonly string[];
}) => {
  const picked = new Set(selection);
  return (
    <>
      {objects.map((o, i) => {
        const src = srcForObject(o);
        if (!src) {
          return null;
        }
        const dragging = picked.has(o.uid);
        return (
          <img
            key={o.uid}
            src={src}
            alt={o.id}
            draggable={false}
            style={{
              left: o.x,
              outline: dragging ? SELECTION_OUTLINE : "none",
              pointerEvents: "none",
              position: "absolute",
              top: o.y,
              transform: spriteTransform(o, dragging),
              zIndex: 10 + i,
            }}
            className="max-w-none [image-rendering:pixelated]"
          />
        );
      })}
    </>
  );
};
/** Every placed sprite in paint order. Memoised: a drag or a marquee must not redraw 700 images. */
const ObjectLayer = memo(ObjectLayerView);

const collisionCells = (collision: readonly string[], cell: number): PixelPoint[] => {
  const cells: PixelPoint[] = [];
  for (const [r, row] of collision.entries()) {
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] === "1") {
        cells.push({ x: c * cell, y: r * cell });
      }
    }
  }
  return cells;
};

const CollisionLayer = ({ layout }: { layout: EditableLayout }) => {
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
            background: "rgba(255,51,102,0.35)",
            height: layout.cell,
            left: c.x,
            pointerEvents: "none",
            position: "absolute",
            top: c.y,
            width: layout.cell,
            zIndex: 100_000,
          }}
        />
      ))}
    </>
  );
};

type MarkerKind = "work" | "rest" | "poi" | "door" | "spawn";
const MARKER_STYLE = {
  door: { background: "#fb923c", outline: "1px solid #431407", zIndex: 100_002 },
  poi: { background: "#f472b6", color: "#2a0a1c", fontSize: 8, zIndex: 100_001 },
  rest: { background: "#34d399", borderRadius: 2, color: "#0b1a14", fontSize: 7, zIndex: 100_001 },
  spawn: { background: "#facc15", borderRadius: 8, zIndex: 100_002 },
  work: { background: "#38bdf8", borderRadius: 8, color: "#0b1a14", fontSize: 7, zIndex: 100_001 },
} satisfies Record<MarkerKind, CSSProperties>;

/** An 8×8 pin centred on a layout point: a seat, a point of interest, the door, the spawn. */
const Marker = ({
  kind,
  at,
  title,
  children,
}: {
  kind: MarkerKind;
  at: PixelPoint;
  title: string;
  children?: ReactNode;
}) => (
  <div
    title={title}
    style={{
      height: 8,
      left: at.x - 4,
      lineHeight: "8px",
      pointerEvents: "none",
      position: "absolute",
      textAlign: "center",
      top: at.y - 4,
      width: 8,
      ...MARKER_STYLE[kind],
    }}
  >
    {children}
  </div>
);

/**
 * The canvas. Pointer gestures edit the document through `edit`; a drag moves
 * the selection with a CSS transform and only touches the document when the
 * pointer lifts, so the object layer never re-renders mid-gesture.
 */
export const Stage = ({
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
}) => {
  const { layout, selection } = doc;
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const paintRef = useRef<0 | 1 | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const sortedObjects = useMemo(() => paintOrder(layout.objects), [layout.objects]);

  const snapTo = (v: number) => (snap > 1 ? Math.round(v / snap) * snap : Math.round(v));

  const worldFromEvent = (e: { clientX: number; clientY: number }): PixelPoint => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) {
      return { x: 0, y: 0 };
    }
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  };

  // hit-test: the object you'd see at (x,y) — the LAST one painted over it
  const hitTest = (x: number, y: number): EditableObject | null => {
    let best: EditableObject | null = null;
    for (const o of sortedObjects) {
      const r = worldRect(o);
      if (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) {
        continue;
      }
      best = o;
    }
    return best;
  };

  const setDragOffset = (dx: number, dy: number) => {
    const el = stageRef.current;
    if (!el) {
      return;
    }
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
      // the whole paint stroke is one undo step
      edit.mark();
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
      if (!placing) {
        return;
      }
      const obj = makeObject(placing.id, sx, sy, { layer: placing.layer, path: placing.path });
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
      setMarquee({ x0: p.x, x1: p.x, y0: p.y, y1: p.y });
      return;
    }
    // a hit outside the selection selects just it; then the whole selection drags
    const group = selection.includes(hit.uid) ? selection : [hit.uid];
    if (e.altKey) {
      // Figma-style alt-drag: duplicate the selection and drag the copies
      const groupSet = new Set(group);
      const clones = layout.objects.filter((o) => groupSet.has(o.uid)).map((o) => cloneObject(o));
      // the whole gesture (clone included) is one undo step
      edit.mark();
      edit.live((d) => ({
        layout: { ...d.layout, objects: [...d.layout.objects, ...clones] },
        selection: clones.map((o) => o.uid),
      }));
      dragRef.current = {
        dx: 0,
        dy: 0,
        marked: true,
        sx: p.x,
        sy: p.y,
        uids: clones.map((o) => o.uid),
      };
      return;
    }
    if (group !== selection) {
      edit.live((d) => withSelection(d, group));
    }
    dragRef.current = { dx: 0, dy: 0, marked: false, sx: p.x, sy: p.y, uids: group };
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
        if (drag.marked) {
          edit.live(moved);
        } else {
          edit.commit(moved);
        }
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
                const r = worldRect(o);
                return !(x1 < r.x || x0 > r.x + r.w || y1 < r.y || y0 > r.y + r.h);
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
        cursor: tool === "select" ? "default" : "crosshair",
        height: layout.height,
        imageRendering: "pixelated",
        outline: "1px solid #333",
        position: "relative",
        transform: `scale(${zoom})`,
        transformOrigin: "top left",
        width: layout.width,
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
            background: "rgba(52,211,153,0.15)",
            border: SELECTION_OUTLINE,
            height: Math.abs(marquee.y1 - marquee.y0),
            left: Math.min(marquee.x0, marquee.x1),
            pointerEvents: "none",
            position: "absolute",
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            zIndex: 100_003,
          }}
        />
      ) : null}
    </div>
  );
};
