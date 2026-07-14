import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  applyOfficeLayout,
  parseOfficeLayout,
  type OfficeLayer,
} from "@/renderer/game/office-layout";
import {
  ALL_OBJECT_IDS,
  assetSrc,
  cloneObject,
  contentBounds,
  deriveCollision,
  flipObject,
  loadLayout,
  makeObject,
  moveObject,
  paintOrder,
  ROOM_TILES,
  serializeLayout,
  setCollisionCell,
  setLayer,
  srcForObject,
  type EditableLayout,
  type EditableObject,
  type Tool,
} from "@/renderer/ui/office-builder/use-builder-state";

type PaletteMode = "objects" | "tiles";

const SNAPS = [1, 8, 16, 32] as const;
const LAYERS: readonly OfficeLayer[] = ["floor", "object", "overhead"];
const TOOLS: readonly { tool: Tool; label: string; hotkey: string }[] = [
  { tool: "select", label: "Select", hotkey: "v" },
  { tool: "place", label: "Place", hotkey: "p" },
  { tool: "spawn", label: "Spawn", hotkey: "s" },
  { tool: "seat", label: "Seat", hotkey: "t" },
  { tool: "block", label: "+Collision", hotkey: "b" },
  { tool: "clear", label: "−Collision", hotkey: "x" },
];
const HISTORY_CAP = 100;

export function OfficeBuilder() {
  const [layout, setLayout] = useState<EditableLayout>(loadLayout);
  const [tool, setTool] = useState<Tool>("select");
  const [paletteId, setPaletteId] = useState<string | null>(null);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("objects");
  const [selectedUids, setSelectedUids] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );
  const [snap, setSnap] = useState<number>(16);
  const [zoom, setZoom] = useState<number>(2);
  const [showCollision, setShowCollision] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Loaded current office. Place assets, then Save.");
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    sx: number;
    sy: number;
    origins: { uid: string; x: number; y: number }[];
  } | null>(null);
  const paintRef = useRef<0 | 1 | null>(null);
  const selSet = new Set(selectedUids);

  const selected =
    selectedUids.length === 1
      ? (layout.objects.find((o) => o.uid === selectedUids[0]) ?? null)
      : null;

  // ---- undo/redo: snapshot history over the whole layout ----
  const layoutRef = useRef(layout);
  const selectedRef = useRef(selectedUids);
  useLayoutEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  useLayoutEffect(() => {
    selectedRef.current = selectedUids;
  }, [selectedUids]);
  interface HistoryEntry {
    layout: EditableLayout;
    selection: string[];
  }
  const historyRef = useRef<{ past: HistoryEntry[]; future: HistoryEntry[] }>({
    past: [],
    future: [],
  });

  /** Apply without recording (mid-drag / mid-paint frames). */
  const applyLive = useCallback((updater: (L: EditableLayout) => EditableLayout) => {
    const next = updater(layoutRef.current);
    layoutRef.current = next;
    setLayout(next);
  }, []);
  /** Record the current state as an undo step (start of a stroke/gesture). */
  const beginStroke = useCallback(() => {
    const h = historyRef.current;
    h.past.push({ layout: layoutRef.current, selection: selectedRef.current });
    if (h.past.length > HISTORY_CAP) h.past.shift();
    h.future = [];
  }, []);
  /** One-shot undoable change. */
  const commit = useCallback(
    (updater: (L: EditableLayout) => EditableLayout) => {
      const next = updater(layoutRef.current);
      if (next === layoutRef.current) return;
      beginStroke();
      layoutRef.current = next;
      setLayout(next);
    },
    [beginStroke],
  );
  const restore = useCallback((entry: HistoryEntry) => {
    layoutRef.current = entry.layout;
    setLayout(entry.layout);
    // restore the selection as it was, minus anything that no longer exists
    setSelectedUids(entry.selection.filter((u) => entry.layout.objects.some((o) => o.uid === u)));
  }, []);
  const undo = useCallback(() => {
    const h = historyRef.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push({ layout: layoutRef.current, selection: selectedRef.current });
    restore(prev);
  }, [restore]);
  const redo = useCallback(() => {
    const h = historyRef.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push({ layout: layoutRef.current, selection: selectedRef.current });
    restore(next);
  }, [restore]);

  const snapTo = useCallback(
    (v: number) => (snap > 1 ? Math.round(v / snap) * snap : Math.round(v)),
    [snap],
  );

  const updateObject = useCallback(
    (uid: string, next: EditableObject) => {
      commit((L) => ({
        ...L,
        objects: L.objects.map((o) => (o.uid === uid ? next : o)),
      }));
    },
    [commit],
  );

  // Restack a flat-band object: those paint in list order, so raising one is
  // literally moving it later in the list (past the next sibling in its band).
  const restackObject = useCallback(
    (uid: string, dir: 1 | -1) => {
      commit((L) => {
        const i = L.objects.findIndex((o) => o.uid === uid);
        const self = L.objects[i];
        if (!self) return L;
        const step = (n: number): number => {
          for (let j = n + dir; j >= 0 && j < L.objects.length; j += dir)
            if (L.objects[j]?.layer === self.layer) return j;
          return n;
        };
        const j = step(i);
        if (j === i) return L;
        const objects = L.objects.slice();
        objects.splice(i, 1);
        objects.splice(j, 0, self);
        return { ...L, objects };
      });
    },
    [commit],
  );

  const deleteUids = useCallback(
    (uids: readonly string[]) => {
      if (uids.length === 0) return;
      const kill = new Set(uids);
      commit((L) => ({ ...L, objects: L.objects.filter((o) => !kill.has(o.uid)) }));
      setSelectedUids((cur) => cur.filter((u) => !kill.has(u)));
    },
    [commit],
  );

  const duplicateUids = useCallback(
    (uids: readonly string[]) => {
      if (uids.length === 0) return;
      const src = new Set(uids);
      const clones = layoutRef.current.objects
        .filter((o) => src.has(o.uid))
        .map((o) => moveObject(cloneObject(o), o.x + 8, o.y + 8));
      commit((L) => ({ ...L, objects: [...L.objects, ...clones] }));
      setSelectedUids(clones.map((o) => o.uid));
    },
    [commit],
  );

  const flipSelection = useCallback(
    (axis: "x" | "y") => {
      const sel = new Set(selectedUids);
      if (sel.size === 0) return;
      commit((L) => ({
        ...L,
        objects: L.objects.map((o) => (sel.has(o.uid) ? flipObject(o, axis) : o)),
      }));
    },
    [selectedUids, commit],
  );

  // hit-test: the object you'd see at (x,y) — the LAST one painted over it
  const hitTest = useCallback(
    (x: number, y: number): EditableObject | null => {
      let best: EditableObject | null = null;
      for (const o of paintOrder(layout.objects)) {
        const b = contentBounds(o);
        const bx = o.x + b.x;
        const by = o.y + b.y;
        if (x < bx || y < by || x >= bx + b.w || y >= by + b.h) continue;
        best = o;
      }
      return best;
    },
    [layout.objects],
  );

  const worldFromEvent = useCallback(
    (e: { clientX: number; clientY: number }): { x: number; y: number } => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
    },
    [zoom],
  );

  const onStagePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const p = worldFromEvent(e);
      const sx = snapTo(p.x);
      const sy = snapTo(p.y);
      if (tool === "block" || tool === "clear") {
        const val: 0 | 1 = tool === "block" ? 1 : 0;
        paintRef.current = val;
        beginStroke(); // the whole paint stroke is one undo step
        const c = Math.floor(p.x / layout.cell);
        const r = Math.floor(p.y / layout.cell);
        applyLive((L) => ({ ...L, collision: setCollisionCell(L.collision, L.cols, c, r, val) }));
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      if (tool === "place" && paletteId) {
        const tile = paletteMode === "tiles" ? ROOM_TILES.find((t) => t.id === paletteId) : null;
        const obj = tile
          ? makeObject(tile.id, sx, sy, { path: tile.path, layer: "floor" })
          : makeObject(paletteId, sx, sy);
        commit((L) => ({ ...L, objects: [...L.objects, obj] }));
        setSelectedUids([obj.uid]); // stay in Place mode so you can keep placing
        return;
      }
      if (tool === "spawn") {
        commit((L) => ({ ...L, spawn: { x: sx, y: sy } }));
        return;
      }
      if (tool === "seat") {
        commit((L) => {
          const near = L.workSeats.findIndex((s) => Math.hypot(s.x - p.x, s.y - p.y) < 12);
          return near >= 0
            ? { ...L, workSeats: L.workSeats.filter((_, i) => i !== near) }
            : { ...L, workSeats: [...L.workSeats, { x: sx, y: sy }] };
        });
        return;
      }
      // select / drag (clicking an object) or marquee (dragging empty space)
      const hit = hitTest(p.x, p.y);
      e.currentTarget.setPointerCapture(e.pointerId);
      if (hit) {
        // if the hit isn't already in the selection, select just it; then drag the whole selection
        const inSel = selectedUids.includes(hit.uid);
        const group = inSel ? selectedUids : [hit.uid];
        const groupSet = new Set(group);
        beginStroke(); // the whole gesture (clone included) is one undo step
        if (e.altKey) {
          // Figma-style alt-drag: duplicate the selection and drag the copies
          const clones = layoutRef.current.objects
            .filter((o) => groupSet.has(o.uid))
            .map((o) => cloneObject(o));
          applyLive((L) => ({ ...L, objects: [...L.objects, ...clones] }));
          setSelectedUids(clones.map((o) => o.uid));
          dragRef.current = {
            sx: p.x,
            sy: p.y,
            origins: clones.map((o) => ({ uid: o.uid, x: o.x, y: o.y })),
          };
          return;
        }
        if (!inSel) setSelectedUids([hit.uid]);
        dragRef.current = {
          sx: p.x,
          sy: p.y,
          origins: layout.objects
            .filter((o) => groupSet.has(o.uid))
            .map((o) => ({ uid: o.uid, x: o.x, y: o.y })),
        };
      } else {
        setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }
    },
    [
      tool,
      paletteId,
      paletteMode,
      snapTo,
      worldFromEvent,
      hitTest,
      layout.objects,
      layout.cell,
      selectedUids,
      beginStroke,
      commit,
      applyLive,
    ],
  );

  const onStagePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const p = worldFromEvent(e);
      if (paintRef.current !== null) {
        const val = paintRef.current;
        const c = Math.floor(p.x / layout.cell);
        const r = Math.floor(p.y / layout.cell);
        applyLive((L) => ({ ...L, collision: setCollisionCell(L.collision, L.cols, c, r, val) }));
        return;
      }
      const drag = dragRef.current;
      if (drag) {
        const dx = snapTo(p.x - drag.sx);
        const dy = snapTo(p.y - drag.sy);
        const moves = new Map(drag.origins.map((o) => [o.uid, o]));
        applyLive((L) => ({
          ...L,
          objects: L.objects.map((o) => {
            const orig = moves.get(o.uid);
            if (!orig) return o;
            return moveObject(o, orig.x + dx, orig.y + dy);
          }),
        }));
        return;
      }
      setMarquee((m) => (m ? { ...m, x1: p.x, y1: p.y } : m));
    },
    [worldFromEvent, snapTo, layout.cell, applyLive],
  );

  const onStagePointerUp = useCallback(() => {
    paintRef.current = null;
    if (marquee) {
      const x0 = Math.min(marquee.x0, marquee.x1);
      const x1 = Math.max(marquee.x0, marquee.x1);
      const y0 = Math.min(marquee.y0, marquee.y1);
      const y1 = Math.max(marquee.y0, marquee.y1);
      if (x1 - x0 > 3 || y1 - y0 > 3) {
        const hits = layout.objects
          .filter((o) => {
            const b = contentBounds(o);
            const bx = o.x + b.x;
            const by = o.y + b.y;
            return !(x1 < bx || x0 > bx + b.w || y1 < by || y0 > by + b.h);
          })
          .map((o) => o.uid);
        setSelectedUids(hits);
      } else {
        setSelectedUids([]); // a click on empty space clears the selection
      }
      setMarquee(null);
    }
    dragRef.current = null;
  }, [marquee, layout.objects]);

  const save = useCallback(async () => {
    const bridge = window.appBridge;
    if (!bridge) {
      setStatus("No app bridge available.");
      return;
    }
    try {
      const json = serializeLayout(layout);
      await bridge.saveOfficeDesign({ json });
      // apply to the live layout bindings: the game scene rebuilds from them
      // when you switch back, so the save is visible immediately
      applyOfficeLayout(JSON.parse(json));
      setStatus("Saved ✓ — switch to Game to see it.");
    } catch (err) {
      setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [layout]);

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const target = e.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
    )
      return;
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
      return;
    }
    if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicateUids(selectedUids);
      return;
    }
    if (mod) return; // don't shadow other app/browser shortcuts

    if (e.key === "Escape") {
      setSelectedUids([]);
      setTool("select");
      return;
    }
    if (e.shiftKey && (e.key === "H" || e.key === "h")) {
      e.preventDefault();
      flipSelection("x");
      return;
    }
    if (e.shiftKey && (e.key === "V" || e.key === "v")) {
      e.preventDefault();
      flipSelection("y");
      return;
    }
    if (!e.shiftKey) {
      const toolFor = TOOLS.find((t) => t.hotkey === e.key.toLowerCase());
      if (toolFor) {
        setTool(toolFor.tool);
        return;
      }
      if (e.key === "-") {
        setZoom((z) => Math.max(1, z - 0.5));
        return;
      }
      if (e.key === "=" || e.key === "+") {
        setZoom((z) => Math.min(5, z + 0.5));
        return;
      }
    }

    if (selectedUids.length === 0) return;
    const step = e.shiftKey ? (snap > 1 ? snap : 10) : 1;
    const d = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[e.key];
    const sel = new Set(selectedUids);
    if (d) {
      e.preventDefault();
      commit((L) => ({
        ...L,
        objects: L.objects.map((o) => (sel.has(o.uid) ? moveObject(o, o.x + d[0], o.y + d[1]) : o)),
      }));
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteUids(selectedUids);
    }
  });

  // keyboard: Figma-style hotkeys (see the cheat sheet in the inspector)
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // show the collision grid whenever you're editing it
  useEffect(() => {
    if (tool === "block" || tool === "clear") setShowCollision(true);
  }, [tool]);

  // load the player's saved office from disk (falls back to the bundled default)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await window.appBridge?.loadOfficeDesign();
      if (cancelled || !res || !res.layout) return;
      try {
        const loaded = loadLayout(parseOfficeLayout(res.layout));
        layoutRef.current = loaded;
        historyRef.current = { past: [], future: [] };
        setLayout(loaded);
        setStatus("Loaded your saved office from disk.");
      } catch {
        // keep the bundled default if the saved file is from an older schema
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedObjects = useMemo(() => paintOrder(layout.objects), [layout.objects]);
  const visibleItems = useMemo<{ id: string; src: string | null }[]>(() => {
    const q = query.trim().toLowerCase();
    if (paletteMode === "tiles") {
      const tiles = q ? ROOM_TILES.filter((t) => t.id.includes(q)) : ROOM_TILES;
      return tiles.map((t) => ({ id: t.id, src: `/${t.path}` }));
    }
    const ids = q ? ALL_OBJECT_IDS.filter((id) => id.includes(q)) : ALL_OBJECT_IDS;
    return ids.map((id) => ({ id, src: assetSrc(id) }));
  }, [query, paletteMode]);

  return (
    <main className="flex h-full w-full bg-[#bfc2c4] text-[var(--text)]">
      {/* palette */}
      <aside className="px-window m-2 flex w-52 shrink-0 flex-col overflow-hidden">
        <div className="px-titlebar flex gap-1 px-2 py-2 text-[13px]">
          {(["objects", "tiles"] as const).map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => setPaletteMode(m)}
              data-sel={paletteMode === m}
              className="px-opt flex-1 px-2 py-1 text-[11px] capitalize"
            >
              {m === "tiles" ? "Room tiles" : "Objects"}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="Search id…"
          className="px-field m-2 text-[12px]"
        />
        <div className="px-scroll grid min-h-0 flex-1 grid-cols-3 gap-1 overflow-y-auto p-2">
          {visibleItems.map((it) => {
            if (!it.src) return null;
            return (
              <button
                type="button"
                key={it.id}
                onClick={() => {
                  setPaletteId(it.id);
                  setTool("place");
                }}
                title={it.id}
                data-sel={paletteId === it.id}
                className="px-opt flex h-12 items-center justify-center overflow-hidden p-1"
              >
                <img
                  src={it.src}
                  alt={it.id}
                  className="max-h-10 max-w-none [image-rendering:pixelated]"
                />
              </button>
            );
          })}
        </div>
      </aside>

      {/* canvas */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="px-window m-2 mb-0 shrink-0">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[11px]">
            {TOOLS.map((t) => (
              <button
                type="button"
                key={t.tool}
                onClick={() => setTool(t.tool)}
                data-sel={tool === t.tool}
                title={`${t.label} (${t.hotkey.toUpperCase()})`}
                className="px-opt px-2.5 py-1.5"
              >
                {t.label}
              </button>
            ))}
            <span className="mx-1 opacity-40">|</span>
            <span className="text-[var(--text-dim)]">snap</span>
            {SNAPS.map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => setSnap(s)}
                data-sel={snap === s}
                className="px-opt px-2 py-1.5"
              >
                {s === 1 ? "free" : s}
              </button>
            ))}
            <span className="mx-1 opacity-40">|</span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(1, z - 0.5))}
              className="px-btn px-2 py-1.5"
            >
              −
            </button>
            <span className="w-8 text-center">{zoom}×</span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(5, z + 0.5))}
              className="px-btn px-2 py-1.5"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => setShowCollision((v) => !v)}
              data-sel={showCollision}
              className="px-opt px-2.5 py-1.5"
            >
              Collision
            </button>
            <button
              type="button"
              onClick={() => {
                commit((L) => ({ ...L, collision: deriveCollision(L) }));
                setStatus("Rebuilt collision from floor tiles + solid furniture.");
                setShowCollision(true);
              }}
              className="px-btn px-2.5 py-1.5"
              title="Re-derive walkability from solid furniture (then Save)"
            >
              Rebuild collision
            </button>
            <span className="ml-auto flex items-center gap-2">
              <a href="#/office-assets" className="px-btn px-2.5 py-1.5">
                Assets
              </a>
              <a href="#/" className="px-btn px-2.5 py-1.5">
                Game
              </a>
              <button
                type="button"
                onClick={() => void save()}
                className="px-btn-accent px-3 py-1.5"
              >
                Save
              </button>
            </span>
          </div>
        </header>
        <div className="px-3 py-1 text-[11px] text-[var(--text-dim)]">{status}</div>
        <div className="px-scroll m-2 mt-0 min-h-0 flex-1 overflow-auto bg-[#14161f] p-4">
          <div
            ref={stageRef}
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerUp}
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
            {sortedObjects.map((o, i) => {
              const src = srcForObject(o);
              if (!src) return null;
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
                    outline: selSet.has(o.uid) ? "1px solid #34d399" : "none",
                    transform:
                      o.flipX || o.flipY
                        ? `scale(${o.flipX ? -1 : 1}, ${o.flipY ? -1 : 1})`
                        : undefined,
                  }}
                  className="max-w-none [image-rendering:pixelated]"
                />
              );
            })}
            {showCollision &&
              collisionCells(layout).map((c) => (
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
            {layout.workSeats.map((s) => (
              <div
                key={`s-${s.x}-${s.y}`}
                style={{
                  position: "absolute",
                  left: s.x - 3,
                  top: s.y - 3,
                  width: 6,
                  height: 6,
                  zIndex: 100001,
                  background: "#38bdf8",
                  borderRadius: 6,
                  pointerEvents: "none",
                }}
              />
            ))}
            <div
              style={{
                position: "absolute",
                left: layout.spawn.x - 4,
                top: layout.spawn.y - 4,
                width: 8,
                height: 8,
                zIndex: 100002,
                background: "#facc15",
                borderRadius: 8,
                pointerEvents: "none",
              }}
            />
            {marquee && (
              <div
                style={{
                  position: "absolute",
                  left: Math.min(marquee.x0, marquee.x1),
                  top: Math.min(marquee.y0, marquee.y1),
                  width: Math.abs(marquee.x1 - marquee.x0),
                  height: Math.abs(marquee.y1 - marquee.y0),
                  zIndex: 100003,
                  background: "rgba(52,211,153,0.15)",
                  border: "1px solid #34d399",
                  pointerEvents: "none",
                }}
              />
            )}
          </div>
        </div>
      </section>

      {/* inspector */}
      <aside className="px-window m-2 flex w-60 shrink-0 flex-col gap-2 overflow-y-auto p-3 text-[12px]">
        <div className="px-titlebar -m-3 mb-1 px-3 py-2 text-[13px]">Inspector</div>
        {selected ? (
          <Inspector
            key={selected.uid}
            obj={selected}
            onChange={(next) => updateObject(selected.uid, next)}
            onRestack={(dir) => restackObject(selected.uid, dir)}
            onDelete={() => deleteUids([selected.uid])}
          />
        ) : selectedUids.length > 1 ? (
          <div className="flex flex-col gap-2">
            <p>{selectedUids.length} objects selected.</p>
            <p className="text-[11px] text-[var(--text-dim)]">
              Drag to move them together; arrows nudge; Delete removes all.
            </p>
            <button
              type="button"
              onClick={() => deleteUids(selectedUids)}
              className="px-btn py-1.5 text-[var(--danger)]"
            >
              Delete {selectedUids.length}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-[var(--text-dim)]">
            <p>
              {tool === "place"
                ? paletteId
                  ? `Click the canvas to place ${paletteId}.`
                  : "Pick an asset from the left."
                : "Click to select, or drag a box to select many."}
            </p>
            <div className="px-inset p-2 text-[10px] leading-relaxed">
              V select · P place · S spawn · T seat · B/X collision
              <br />
              ⌘Z undo · ⇧⌘Z redo · ⌘D / ⌥drag duplicate · ⌘S save
              <br />
              ⇧H flip horizontal · ⇧V flip vertical
              <br />
              arrows nudge (⇧ = snap step) · Delete remove · Esc deselect
              <br />
              <br />
              Layers: floor = flat under everyone · object = y-sorts with walkers (in front when
              they're above it, behind when below) · overhead = always on top.
            </div>
          </div>
        )}
        <div className="mt-auto text-[10px] text-[var(--text-dim)]">
          {layout.objects.length} objects · {layout.workSeats.length} seats · {layout.width}×
          {layout.height}
        </div>
      </aside>
    </main>
  );
}

function Inspector({
  obj,
  onChange,
  onRestack,
  onDelete,
}: {
  obj: EditableObject;
  onChange: (next: EditableObject) => void;
  onRestack: (dir: 1 | -1) => void;
  onDelete: () => void;
}) {
  const src = srcForObject(obj);
  return (
    <div className="flex flex-col gap-2">
      <div className="px-inset flex items-center gap-2 p-2">
        {src ? (
          <img
            src={src}
            alt={obj.id}
            style={{
              transform:
                obj.flipX || obj.flipY
                  ? `scale(${obj.flipX ? -1 : 1}, ${obj.flipY ? -1 : 1})`
                  : undefined,
            }}
            className="max-h-12 max-w-none [image-rendering:pixelated]"
          />
        ) : null}
        <span className="truncate">{obj.id}</span>
      </div>
      <label className="flex items-center justify-between gap-2">
        x
        <input
          type="number"
          value={obj.x}
          onChange={(e) => onChange(moveObject(obj, Number(e.currentTarget.value), obj.y))}
          className="px-field w-20 text-right"
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        y
        <input
          type="number"
          value={obj.y}
          onChange={(e) => onChange(moveObject(obj, obj.x, Number(e.currentTarget.value)))}
          className="px-field w-20 text-right"
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        layer
        <select
          value={obj.layer}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v === "floor" || v === "object" || v === "overhead") onChange(setLayer(obj, v));
          }}
          className="px-field"
        >
          {LAYERS.map((l) => (
            <option key={l} value={l}>
              {l === "floor"
                ? "floor — flat, under everyone"
                : l === "object"
                  ? "object — y-sorts with walkers"
                  : "overhead — always on top"}
            </option>
          ))}
        </select>
      </label>
      {/* Only the y-sorting band has a floor line. The flat bands paint in list
          order instead, so what they get is a way to move within that order. */}
      {obj.layer === "object" ? (
        <>
          <label className="flex items-center justify-between gap-2">
            anchorY
            <input
              type="number"
              value={obj.anchorY}
              onChange={(e) => onChange({ ...obj, anchorY: Number(e.currentTarget.value) })}
              className="px-field w-20 text-right"
            />
          </label>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => onChange(moveObject(obj, obj.x, obj.y))}
              className="px-btn flex-1 py-1.5"
              title="Snap the anchor back to the sprite's floor line"
            >
              Auto anchor
            </button>
          </div>
        </>
      ) : (
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onRestack(-1)}
            className="px-btn flex-1 py-1.5"
            title="Paint this one earlier — behind its neighbours in this layer"
          >
            Send back
          </button>
          <button
            type="button"
            onClick={() => onRestack(1)}
            className="px-btn flex-1 py-1.5"
            title="Paint this one later — in front of its neighbours in this layer"
          >
            Bring forward
          </button>
        </div>
      )}
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => onChange(flipObject(obj, "x"))}
          data-sel={obj.flipX}
          className="px-opt flex-1 py-1.5"
          title="Flip horizontal (⇧H)"
        >
          Flip H
        </button>
        <button
          type="button"
          onClick={() => onChange(flipObject(obj, "y"))}
          data-sel={obj.flipY}
          className="px-opt flex-1 py-1.5"
          title="Flip vertical (⇧V)"
        >
          Flip V
        </button>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={obj.solid}
          onChange={(e) => onChange({ ...obj, solid: e.currentTarget.checked })}
        />
        solid (blocks walking)
      </label>
      <button type="button" onClick={onDelete} className="px-btn py-1.5 text-[var(--danger)]">
        Delete
      </button>
    </div>
  );
}

function collisionCells(L: EditableLayout): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  L.collision.forEach((row, r) => {
    for (let c = 0; c < row.length; c++)
      if (row[c] === "1") cells.push({ x: c * L.cell, y: r * L.cell });
  });
  return cells;
}
