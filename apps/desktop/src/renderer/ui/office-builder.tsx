import { Toggle } from "@base-ui/react/toggle";
import { Picker } from "@/renderer/ui/picker";
import type { PickerOption } from "@/renderer/ui/picker";
import { memo, useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { layoutOf } from "@/renderer/game/office-layout";
import type { PixelPoint } from "@/renderer/game/office-layout";
import { useHistory } from "@/renderer/hooks/use-history";
import { useSubmission } from "@/renderer/hooks/use-submission";
import { bridge } from "@/renderer/bridge";
import { setLayout } from "@/renderer/state/store";
import { Failure } from "@/renderer/ui/failure";
import { Inspector } from "@/renderer/ui/office-builder/inspector";
import {
  ALL_OBJECT_IDS,
  addSelected,
  assetSrc,
  duplicates,
  flipObject,
  loadLayout,
  moveObjects,
  ROOM_TILES,
  sealPockets,
  toLayoutData,
  withLayout,
} from "@/renderer/ui/office-builder/office-builder-model";
import type {
  BuilderDoc,
  EditableLayout,
  EditableObject,
  Tool,
} from "@/renderer/ui/office-builder/office-builder-model";
import { Stage } from "@/renderer/ui/office-builder/stage";
import type { Placing } from "@/renderer/ui/office-builder/stage";
import { layoutIssues } from "@/shared/office-grid";
import { schemaIssues } from "@/shared/office-layout-schema";
import type { OfficeDesign } from "@/shared/office-layout-schema";

type PaletteMode = "objects" | "tiles";

const SNAPS = [1, 8, 16, 32] as const;
const MODES: readonly PickerOption<PaletteMode>[] = [
  { label: "Objects", value: "objects" },
  { label: "Room tiles", value: "tiles" },
];
const TOOLS: readonly { tool: Tool; label: string; hotkey: string }[] = [
  { hotkey: "v", label: "Select", tool: "select" },
  { hotkey: "p", label: "Place", tool: "place" },
  { hotkey: "s", label: "Spawn", tool: "spawn" },
  { hotkey: "d", label: "Door", tool: "door" },
  { hotkey: "t", label: "Seat", tool: "seat" },
  { hotkey: "r", label: "Rest chair", tool: "rest" },
  { hotkey: "i", label: "POI", tool: "poi" },
  { hotkey: "b", label: "+Collision", tool: "block" },
  { hotkey: "x", label: "−Collision", tool: "clear" },
];
const TOOL_OPTIONS: readonly PickerOption<Tool>[] = TOOLS.map((t) => ({
  label: t.label,
  title: `${t.label} (${t.hotkey.toUpperCase()})`,
  value: t.tool,
}));
/** Snap distances as picker keys; the geometry keeps working in numbers. */
type SnapKey = `${(typeof SNAPS)[number]}`;
const SNAP_OPTIONS: readonly PickerOption<SnapKey>[] = SNAPS.map((s) => ({
  label: s === 1 ? "free" : s,
  value: `${s}`,
}));
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
  src: string;
}

const PaletteView = ({
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
}) => (
  <aside className="px-window m-2 flex w-52 shrink-0 flex-col overflow-hidden">
    <div className="px-titlebar flex gap-1 px-2 py-2 text-sm">
      <Picker
        options={MODES}
        value={mode}
        onChange={onMode}
        label="Palette"
        className="flex flex-1 gap-1"
        itemClassName="flex-1 px-2 py-1"
      />
    </div>
    <input
      value={query}
      onChange={(e) => onQuery(e.currentTarget.value)}
      placeholder="Search id…"
      className="px-field m-2"
    />
    <div className="px-scroll grid min-h-0 flex-1 grid-cols-3 gap-1 overflow-y-auto p-2">
      {items.map((it) => (
        <button
          type="button"
          key={it.id}
          onClick={() => onPick(it.id)}
          title={it.id}
          data-pressed={picked === it.id ? "" : undefined}
          className="px-opt flex h-12 items-center justify-center overflow-hidden p-1"
        >
          <img
            src={it.src}
            alt={it.id}
            className="max-h-10 max-w-none [image-rendering:pixelated]"
          />
        </button>
      ))}
    </div>
  </aside>
);
/** The catalog column. Memoised: a drag redraws the stage every frame and must not re-reconcile ~700 thumbnails. */
const Palette = memo(PaletteView);

const Toolbar = ({
  tool,
  onTool,
  snap,
  onSnap,
  zoom,
  onZoomIn,
  onZoomOut,
  showCollision,
  onToggleCollision,
  onSealPockets,
  onSave,
  saving,
}: {
  tool: Tool;
  onTool: (tool: Tool) => void;
  snap: number;
  onSnap: (snap: number) => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  showCollision: boolean;
  onToggleCollision: (pinned: boolean) => void;
  onSealPockets: () => void;
  onSave: () => void;
  saving: boolean;
}) => (
  <header className="px-window m-2 mb-0 shrink-0">
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
      <Picker
        options={TOOL_OPTIONS}
        value={tool}
        onChange={onTool}
        label="Tool"
        className="flex gap-2"
        itemClassName="px-2.5 py-1.5"
      />
      <span className="mx-1 opacity-40">|</span>
      <span className="text-fg-dim">snap</span>
      <Picker
        options={SNAP_OPTIONS}
        value={`${snap}`}
        onChange={(key) => onSnap(Number(key))}
        label="Snap"
        className="flex gap-2"
        itemClassName="px-2 py-1.5"
      />
      <span className="mx-1 opacity-40">|</span>
      <button type="button" onClick={onZoomOut} className="px-btn px-2 py-1.5">
        −
      </button>
      <span className="w-8 text-center">{zoom}×</span>
      <button type="button" onClick={onZoomIn} className="px-btn px-2 py-1.5">
        +
      </button>
      <Toggle
        pressed={showCollision}
        onPressedChange={onToggleCollision}
        className="px-opt px-2.5 py-1.5"
      >
        Collision
      </Toggle>
      <button
        type="button"
        onClick={onSealPockets}
        className="px-btn px-2.5 py-1.5"
        title="Close open floor no body can stand on (then Save)"
      >
        Seal pockets
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
          onClick={onSave}
          disabled={saving}
          className="px-btn-accent px-3 py-1.5"
        >
          Save
        </button>
      </span>
    </div>
  </header>
);

const placeHint = (placing: Placing | null): string =>
  placing ? `Click the canvas to place ${placing.id}.` : "Pick an asset from the left.";

const Hints = ({ tool, placing }: { tool: Tool; placing: Placing | null }) => (
  <div className="flex flex-col gap-2 text-fg-dim">
    <p>
      {tool === "place" ? placeHint(placing) : "Click to select, or drag a box to select many."}
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
      Layers: floor = flat under everyone · object = y-sorts with walkers (in front when
      they&apos;re above it, behind when below) · overhead = always on top.
    </div>
  </div>
);

const SelectionSummary = ({
  selection,
  tool,
  placing,
  onDelete,
}: {
  selection: readonly string[];
  tool: Tool;
  placing: Placing | null;
  onDelete: (uids: readonly string[]) => void;
}) => {
  if (selection.length > 1) {
    return (
      <div className="flex flex-col gap-2">
        <p>{selection.length} objects selected.</p>
        <p className="text-xs text-fg-dim">
          Drag to move them together; arrows nudge; Delete removes all.
        </p>
        <button
          type="button"
          onClick={() => onDelete(selection)}
          className="px-btn px-btn-danger py-1.5"
        >
          Delete {selection.length}
        </button>
      </div>
    );
  }
  return <Hints tool={tool} placing={placing} />;
};

/** What the builder opened on, and what Save will do to the file on disk. */
const openingStatus = (design: OfficeDesign): string => {
  switch (design.kind) {
    case "absent": {
      return "Loaded the default office. Place assets, then Save.";
    }
    case "saved": {
      return "Loaded your saved office. Place assets, then Save.";
    }
    case "unreadable": {
      return `Couldn't read your saved office (${design.reason}). Showing the default; Save replaces that file.`;
    }
    case "newer": {
      return "Your saved office is from a newer IdleBiz. Showing the default; Save can't replace it — update IdleBiz to edit it.";
    }
    // no default
  }
};

const nudgeStep = (e: KeyboardEvent, snap: number): number => {
  if (!e.shiftKey) {
    return 1;
  }
  return snap > 1 ? snap : 10;
};

export const OfficeBuilder = ({ design }: { design: OfficeDesign }) => {
  const history = useHistory<BuilderDoc>(() => ({
    layout: loadLayout(layoutOf(design)),
    selection: [],
  }));
  const { layout, selection } = history.present;
  const [tool, setTool] = useState<Tool>("select");
  const [paletteId, setPaletteId] = useState<string | null>(null);
  const pickFromPalette = useCallback((id: string) => {
    setPaletteId(id);
    setTool("place");
  }, []);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("objects");
  const [snap, setSnap] = useState<number>(16);
  const [zoom, setZoom] = useState<number>(2);
  const [collisionPinned, setCollisionPinned] = useState(false);
  // editing collision always shows it; the toggle is for the other tools
  const showCollision = collisionPinned || tool === "block" || tool === "clear";
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(() => openingStatus(design));

  const selected =
    selection.length === 1 ? (layout.objects.find((o) => o.uid === selection[0]) ?? null) : null;

  const commitLayout = (updater: (L: EditableLayout) => EditableLayout) =>
    history.commit((d) => withLayout(d, updater(d.layout)));
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
      if (!self) {
        return L;
      }
      let j = i;
      for (let k = i + dir; k >= 0 && k < L.objects.length; k += dir) {
        if (L.objects[k]?.layer === self.layer) {
          j = k;
          break;
        }
      }
      if (j === i) {
        return L;
      }
      const objects = [...L.objects];
      objects.splice(i, 1);
      objects.splice(j, 0, self);
      return { ...L, objects };
    });

  const deleteUids = (uids: readonly string[]) => {
    if (uids.length === 0) {
      return;
    }
    const kill = new Set(uids);
    history.commit((d) => ({
      layout: { ...d.layout, objects: d.layout.objects.filter((o) => !kill.has(o.uid)) },
      selection: d.selection.filter((u) => !kill.has(u)),
    }));
  };

  const duplicateUids = (uids: readonly string[]) => {
    if (uids.length === 0) {
      return;
    }
    history.commit((d) => addSelected(d, duplicates(d.layout, uids, 8, 8)));
  };

  const flipSelection = (axis: "x" | "y") => {
    const sel = new Set(selection);
    if (sel.size === 0) {
      return;
    }
    commitLayout((L) => ({
      ...L,
      objects: L.objects.map((o) => (sel.has(o.uid) ? flipObject(o, axis) : o)),
    }));
  };

  const nudgeSelection = (d: PixelPoint) =>
    commitLayout((L) => moveObjects(L, selection, d.x, d.y));

  const saving = useSubmission(async () => {
    // Main's schema and walk judges, run here first so every reason reads plainly
    // rather than as IPC's payload validation error. Art and sight need the PNGs main reads.
    const data = toLayoutData(layout);
    const issues = [...schemaIssues(data), ...layoutIssues(data)];
    if (issues.length > 0) {
      throw new Error(issues.join("; "));
    }
    await bridge().saveOfficeDesign({ layout: data });
    // the layout in force: the scene rebuilds from it when you switch back
    setLayout(data);
    setStatus("Saved ✓ — switch to Game to see it.");
  });
  const save = () => {
    if (saving.submission.kind !== "sending") {
      saving.submit();
    }
  };

  // ⌘Z undo · ⇧⌘Z redo · ⌘S save · ⌘D duplicate; other ⌘ keys stay with the app/browser
  const onModKey = (e: KeyboardEvent, key: string) => {
    if (key === "z") {
      e.preventDefault();
      if (e.shiftKey) {
        history.redo();
      } else {
        history.undo();
      }
      return;
    }
    if (key === "s") {
      e.preventDefault();
      save();
      return;
    }
    if (key === "d") {
      e.preventDefault();
      duplicateUids(selection);
    }
  };

  /** Tool hotkeys and zoom; false when the key is none of them. */
  const onPlainKey = (e: KeyboardEvent, key: string): boolean => {
    const toolFor = TOOLS.find((t) => t.hotkey === key);
    if (toolFor) {
      setTool(toolFor.tool);
      return true;
    }
    if (e.key === "-") {
      zoomOut();
      return true;
    }
    if (e.key === "=" || e.key === "+") {
      zoomIn();
      return true;
    }
    return false;
  };

  // keyboard: Figma-style hotkeys (see the cheat sheet in the inspector)
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (isTyping(e.target)) {
      return;
    }
    const key = e.key.toLowerCase();
    if (e.metaKey || e.ctrlKey) {
      onModKey(e, key);
      return;
    }
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
    if (!e.shiftKey && onPlainKey(e, key)) {
      return;
    }

    if (selection.length === 0) {
      return;
    }
    const step = nudgeStep(e, snap);
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

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    if (paletteMode === "tiles") {
      const tiles = q ? ROOM_TILES.filter((t) => t.id.includes(q)) : ROOM_TILES;
      return tiles.map((t) => ({ id: t.id, src: t.path }));
    }
    const ids = q ? ALL_OBJECT_IDS.filter((id) => id.includes(q)) : ALL_OBJECT_IDS;
    return ids.map((id) => ({ id, src: assetSrc(id) }));
  }, [query, paletteMode]);

  const placing = useMemo<Placing | null>(() => {
    if (!paletteId) {
      return null;
    }
    const tile = paletteMode === "tiles" ? ROOM_TILES.find((t) => t.id === paletteId) : undefined;
    return tile ? { id: tile.id, layer: "floor", path: tile.path } : { id: paletteId };
  }, [paletteId, paletteMode]);

  return (
    <main className="flex h-full w-full bg-[#bfc2c4] text-fg">
      <Palette
        mode={paletteMode}
        onMode={setPaletteMode}
        query={query}
        onQuery={setQuery}
        items={paletteItems}
        picked={paletteId}
        onPick={pickFromPalette}
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
          onToggleCollision={setCollisionPinned}
          onSealPockets={() => {
            commitLayout((L) => ({ ...L, collision: sealPockets(L) }));
            setStatus("Sealed open floor no body can reach.");
            setCollisionPinned(true);
          }}
          onSave={save}
          saving={saving.submission.kind === "sending"}
        />
        <div className="px-3 py-1 text-xs text-fg-dim">
          {status}
          <Failure submission={saving.submission} doing="save" />
        </div>
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
        ) : (
          <SelectionSummary
            selection={selection}
            tool={tool}
            placing={placing}
            onDelete={deleteUids}
          />
        )}
        <div className="mt-auto text-xs text-fg-dim">
          {layout.objects.length} objects · {layout.seats.length} seats · {layout.pois.length} POIs
          · {layout.width}×{layout.height}
        </div>
      </aside>
    </main>
  );
};
