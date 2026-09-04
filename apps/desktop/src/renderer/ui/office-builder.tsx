import { useEffect, useEffectEvent, useMemo, useState } from "react";
import {
  applyOfficeLayout,
  parseOfficeLayout,
  type PixelPoint,
} from "@/renderer/game/office-layout";
import { useHistory } from "@/renderer/hooks/use-history";
import { bridge } from "@/renderer/state/store";
import { Inspector } from "@/renderer/ui/office-builder/inspector";
import {
  ALL_OBJECT_IDS,
  assetSrc,
  cloneObject,
  deriveCollision,
  flipObject,
  loadLayout,
  moveObject,
  ROOM_TILES,
  toLayoutData,
  type BuilderDoc,
  type EditableLayout,
  type EditableObject,
  type Tool,
} from "@/renderer/ui/office-builder/office-builder-model";
import { Stage, type Placing } from "@/renderer/ui/office-builder/stage";
import { errorMessage } from "@/shared/errors";
import { layoutIssues } from "@/shared/office-grid";
import { schemaIssues } from "@/shared/office-layout-schema";

type PaletteMode = "objects" | "tiles";

const SNAPS = [1, 8, 16, 32] as const;
const TOOLS: readonly { tool: Tool; label: string; hotkey: string }[] = [
  { tool: "select", label: "Select", hotkey: "v" },
  { tool: "place", label: "Place", hotkey: "p" },
  { tool: "spawn", label: "Spawn", hotkey: "s" },
  { tool: "door", label: "Door", hotkey: "d" },
  { tool: "seat", label: "Seat", hotkey: "t" },
  { tool: "rest", label: "Rest chair", hotkey: "r" },
  { tool: "poi", label: "POI", hotkey: "i" },
  { tool: "block", label: "+Collision", hotkey: "b" },
  { tool: "clear", label: "−Collision", hotkey: "x" },
];
const ZOOM_MIN = 1;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.5;
const NUDGE = new Map<string, PixelPoint>([
  ["ArrowLeft", { x: -1, y: 0 }],
  ["ArrowRight", { x: 1, y: 0 }],
  ["ArrowUp", { x: 0, y: -1 }],
  ["ArrowDown", { x: 0, y: 1 }],
]);

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

interface PaletteItem {
  id: string;
  src: string | null;
}

function Palette({
  mode,
  onMode,
  query,
  onQuery,
  items,
  picked,
  onPick,
}: {
  mode: PaletteMode;
  onMode: (mode: PaletteMode) => void;
  query: string;
  onQuery: (query: string) => void;
  items: PaletteItem[];
  picked: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <aside className="px-window m-2 flex w-52 shrink-0 flex-col overflow-hidden">
      <div className="px-titlebar flex gap-1 px-2 py-2 text-sm">
        {(["objects", "tiles"] as const).map((m) => (
          <button
            type="button"
            key={m}
            onClick={() => onMode(m)}
            data-sel={mode === m}
            className="px-opt flex-1 px-2 py-1 capitalize"
          >
            {m === "tiles" ? "Room tiles" : "Objects"}
          </button>
        ))}
      </div>
      <input
        value={query}
        onChange={(e) => onQuery(e.currentTarget.value)}
        placeholder="Search id…"
        className="px-field m-2"
      />
      <div className="px-scroll grid min-h-0 flex-1 grid-cols-3 gap-1 overflow-y-auto p-2">
        {items.map((it) => {
          if (!it.src) return null;
          return (
            <button
              type="button"
              key={it.id}
              onClick={() => onPick(it.id)}
              title={it.id}
              data-sel={picked === it.id}
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
  );
}

function Toolbar({
  tool,
  onTool,
  snap,
  onSnap,
  zoom,
  onZoomIn,
  onZoomOut,
  showCollision,
  onToggleCollision,
  onRebuildCollision,
  onSave,
}: {
  tool: Tool;
  onTool: (tool: Tool) => void;
  snap: number;
  onSnap: (snap: number) => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  showCollision: boolean;
  onToggleCollision: () => void;
  onRebuildCollision: () => void;
  onSave: () => void;
}) {
  return (
    <header className="px-window m-2 mb-0 shrink-0">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
        {TOOLS.map((t) => (
          <button
            type="button"
            key={t.tool}
            onClick={() => onTool(t.tool)}
            data-sel={tool === t.tool}
            title={`${t.label} (${t.hotkey.toUpperCase()})`}
            className="px-opt px-2.5 py-1.5"
          >
            {t.label}
          </button>
        ))}
        <span className="mx-1 opacity-40">|</span>
        <span className="text-text-dim">snap</span>
        {SNAPS.map((s) => (
          <button
            type="button"
            key={s}
            onClick={() => onSnap(s)}
            data-sel={snap === s}
            className="px-opt px-2 py-1.5"
          >
            {s === 1 ? "free" : s}
          </button>
        ))}
        <span className="mx-1 opacity-40">|</span>
        <button type="button" onClick={onZoomOut} className="px-btn px-2 py-1.5">
          −
        </button>
        <span className="w-8 text-center">{zoom}×</span>
        <button type="button" onClick={onZoomIn} className="px-btn px-2 py-1.5">
          +
        </button>
        <button
          type="button"
          onClick={onToggleCollision}
          data-sel={showCollision}
          className="px-opt px-2.5 py-1.5"
        >
          Collision
        </button>
        <button
          type="button"
          onClick={onRebuildCollision}
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
          <button type="button" onClick={onSave} className="px-btn-accent px-3 py-1.5">
            Save
          </button>
        </span>
      </div>
    </header>
  );
}

function Hints({ tool, placing }: { tool: Tool; placing: Placing | null }) {
  return (
    <div className="flex flex-col gap-2 text-text-dim">
      <p>
        {tool === "place"
          ? placing
            ? `Click the canvas to place ${placing.id}.`
            : "Pick an asset from the left."
          : "Click to select, or drag a box to select many."}
      </p>
      <div className="px-inset p-2 text-xs leading-relaxed">
        V select · P place · S spawn · D door · B/X collision
        <br />
        T seat · R rest chair · I point of interest: click to add, click again to remove, ⇧click to
        turn
        <br />
        ⌘Z undo · ⇧⌘Z redo · ⌘D / ⌥drag duplicate · ⌘S save
        <br />
        ⇧H flip horizontal · ⇧V flip vertical
        <br />
        arrows nudge (⇧ = snap step) · Delete remove · Esc deselect
        <br />
        <br />
        Layers: floor = flat under everyone · object = y-sorts with walkers (in front when they're
        above it, behind when below) · overhead = always on top.
      </div>
    </div>
  );
}

export function OfficeBuilder() {
  const history = useHistory<BuilderDoc>(() => ({ layout: loadLayout(), selection: [] }));
  const { layout, selection } = history.present;
  const [tool, setTool] = useState<Tool>("select");
  const [paletteId, setPaletteId] = useState<string | null>(null);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("objects");
  const [snap, setSnap] = useState<number>(16);
  const [zoom, setZoom] = useState<number>(2);
  const [collisionPinned, setCollisionPinned] = useState(false);
  // editing collision always shows it; the toggle is for the other tools
  const showCollision = collisionPinned || tool === "block" || tool === "clear";
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Loaded current office. Place assets, then Save.");

  const selected =
    selection.length === 1 ? (layout.objects.find((o) => o.uid === selection[0]) ?? null) : null;

  const commitLayout = (updater: (L: EditableLayout) => EditableLayout) =>
    history.commit((d) => {
      const next = updater(d.layout);
      return next === d.layout ? d : { ...d, layout: next };
    });
  const select = (uids: readonly string[]) => history.live((d) => ({ ...d, selection: uids }));
  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP));

  const updateObject = (uid: string, next: EditableObject) =>
    commitLayout((L) => ({ ...L, objects: L.objects.map((o) => (o.uid === uid ? next : o)) }));

  // Restack a flat-band object: those paint in list order, so raising one is
  // literally moving it later in the list (past the next sibling in its band).
  const restackObject = (uid: string, dir: 1 | -1) =>
    commitLayout((L) => {
      const i = L.objects.findIndex((o) => o.uid === uid);
      const self = L.objects[i];
      if (!self) return L;
      let j = i;
      for (let k = i + dir; k >= 0 && k < L.objects.length; k += dir) {
        if (L.objects[k]?.layer === self.layer) {
          j = k;
          break;
        }
      }
      if (j === i) return L;
      const objects = L.objects.slice();
      objects.splice(i, 1);
      objects.splice(j, 0, self);
      return { ...L, objects };
    });

  const deleteUids = (uids: readonly string[]) => {
    if (uids.length === 0) return;
    const kill = new Set(uids);
    history.commit((d) => ({
      layout: { ...d.layout, objects: d.layout.objects.filter((o) => !kill.has(o.uid)) },
      selection: d.selection.filter((u) => !kill.has(u)),
    }));
  };

  const duplicateUids = (uids: readonly string[]) => {
    if (uids.length === 0) return;
    const src = new Set(uids);
    history.commit((d) => {
      const clones = d.layout.objects
        .filter((o) => src.has(o.uid))
        .map((o) => moveObject(cloneObject(o), o.x + 8, o.y + 8));
      return {
        layout: { ...d.layout, objects: [...d.layout.objects, ...clones] },
        selection: clones.map((o) => o.uid),
      };
    });
  };

  const flipSelection = (axis: "x" | "y") => {
    const sel = new Set(selection);
    if (sel.size === 0) return;
    commitLayout((L) => ({
      ...L,
      objects: L.objects.map((o) => (sel.has(o.uid) ? flipObject(o, axis) : o)),
    }));
  };

  const nudgeSelection = (d: PixelPoint) => {
    const sel = new Set(selection);
    commitLayout((L) => ({
      ...L,
      objects: L.objects.map((o) => (sel.has(o.uid) ? moveObject(o, o.x + d.x, o.y + d.y) : o)),
    }));
  };

  const save = async () => {
    // The same judges main applies before writing, run here first so the reasons
    // land in the status line instead of an IPC error.
    const data = toLayoutData(layout);
    const issues = [...schemaIssues(data), ...layoutIssues(data)];
    if (issues.length > 0) {
      setStatus(`Not saved — ${issues.join("; ")}`);
      return;
    }
    try {
      await bridge().saveOfficeDesign({ json: JSON.stringify(data) });
      // apply to the live layout bindings: the game scene rebuilds from them
      // when you switch back, so the save is visible immediately
      applyOfficeLayout(data);
      setStatus("Saved ✓ — switch to Game to see it.");
    } catch (err) {
      setStatus(`Save failed: ${errorMessage(err)}`);
    }
  };

  // keyboard: Figma-style hotkeys (see the cheat sheet in the inspector)
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    if (mod && key === "z") {
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
      return;
    }
    if (mod && key === "s") {
      e.preventDefault();
      void save();
      return;
    }
    if (mod && key === "d") {
      e.preventDefault();
      duplicateUids(selection);
      return;
    }
    if (mod) return; // don't shadow other app/browser shortcuts

    if (e.key === "Escape") {
      select([]);
      setTool("select");
      return;
    }
    if (e.shiftKey && key === "h") {
      e.preventDefault();
      flipSelection("x");
      return;
    }
    if (e.shiftKey && key === "v") {
      e.preventDefault();
      flipSelection("y");
      return;
    }
    if (!e.shiftKey) {
      const toolFor = TOOLS.find((t) => t.hotkey === key);
      if (toolFor) {
        setTool(toolFor.tool);
        return;
      }
      if (e.key === "-") {
        zoomOut();
        return;
      }
      if (e.key === "=" || e.key === "+") {
        zoomIn();
        return;
      }
    }

    if (selection.length === 0) return;
    const step = e.shiftKey ? (snap > 1 ? snap : 10) : 1;
    const d = NUDGE.get(e.key);
    if (d) {
      e.preventDefault();
      nudgeSelection({ x: d.x * step, y: d.y * step });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteUids(selection);
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // load the player's saved office from disk (falls back to the bundled default)
  const loadSaved = useEffectEvent((layout: EditableLayout) => {
    history.reset({ layout, selection: [] });
    setStatus("Loaded your saved office from disk.");
  });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await bridge().loadOfficeDesign();
      if (cancelled || !res.layout) return;
      try {
        loadSaved(loadLayout(parseOfficeLayout(res.layout)));
      } catch {
        // keep the bundled default if the saved file is from an older schema
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    if (paletteMode === "tiles") {
      const tiles = q ? ROOM_TILES.filter((t) => t.id.includes(q)) : ROOM_TILES;
      return tiles.map((t) => ({ id: t.id, src: `/${t.path}` }));
    }
    const ids = q ? ALL_OBJECT_IDS.filter((id) => id.includes(q)) : ALL_OBJECT_IDS;
    return ids.map((id) => ({ id, src: assetSrc(id) }));
  }, [query, paletteMode]);

  const placing = useMemo<Placing | null>(() => {
    if (!paletteId) return null;
    const tile = paletteMode === "tiles" ? ROOM_TILES.find((t) => t.id === paletteId) : undefined;
    return tile ? { id: tile.id, path: tile.path, layer: "floor" } : { id: paletteId };
  }, [paletteId, paletteMode]);

  return (
    <main className="flex h-full w-full bg-[#bfc2c4] text-text">
      <Palette
        mode={paletteMode}
        onMode={setPaletteMode}
        query={query}
        onQuery={setQuery}
        items={paletteItems}
        picked={paletteId}
        onPick={(id) => {
          setPaletteId(id);
          setTool("place");
        }}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <Toolbar
          tool={tool}
          onTool={setTool}
          snap={snap}
          onSnap={setSnap}
          zoom={zoom}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          showCollision={showCollision}
          onToggleCollision={() => setCollisionPinned((v) => !v)}
          onRebuildCollision={() => {
            commitLayout((L) => ({ ...L, collision: deriveCollision(L) }));
            setStatus("Rebuilt collision from floor tiles + solid furniture.");
            setCollisionPinned(true);
          }}
          onSave={() => void save()}
        />
        <div className="px-3 py-1 text-xs text-text-dim">{status}</div>
        <div className="px-scroll m-2 mt-0 min-h-0 flex-1 overflow-auto bg-[#14161f] p-4">
          <Stage
            doc={history.present}
            edit={history}
            tool={tool}
            snap={snap}
            zoom={zoom}
            placing={placing}
            showCollision={showCollision}
          />
        </div>
      </section>

      <aside className="px-window m-2 flex w-60 shrink-0 flex-col gap-2 overflow-y-auto p-3 text-xs">
        <div className="px-titlebar -m-3 mb-1 px-3 py-2 text-sm">Inspector</div>
        {selected ? (
          <Inspector
            key={selected.uid}
            obj={selected}
            onChange={(next) => updateObject(selected.uid, next)}
            onRestack={(dir) => restackObject(selected.uid, dir)}
            onDelete={() => deleteUids([selected.uid])}
          />
        ) : selection.length > 1 ? (
          <div className="flex flex-col gap-2">
            <p>{selection.length} objects selected.</p>
            <p className="text-xs text-text-dim">
              Drag to move them together; arrows nudge; Delete removes all.
            </p>
            <button
              type="button"
              onClick={() => deleteUids(selection)}
              className="px-btn px-btn-danger py-1.5"
            >
              Delete {selection.length}
            </button>
          </div>
        ) : (
          <Hints tool={tool} placing={placing} />
        )}
        <div className="mt-auto text-xs text-text-dim">
          {layout.objects.length} objects · {layout.seats.length} seats · {layout.pois.length} POIs
          · {layout.width}×{layout.height}
        </div>
      </aside>
    </main>
  );
}
