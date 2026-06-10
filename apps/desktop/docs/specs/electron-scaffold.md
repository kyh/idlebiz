# SPEC: electron-scaffold

Got the catalog versions. I have all the source I need. Producing the blueprint.

---

# SCAFFOLD blueprint — Electron + React 19 + Phaser 4 + typed IPC

Based on `inteligir/apps/desktop`. Stripped of voice/dispatch/agent/executor/widget specifics. One deviation flagged up front:

> **zod vs typebox.** You asked for zod schemas. Inteligir uses `@sinclair/typebox` (`Value.Check`) for IPC validation, not zod. The registry _pattern_ (single source of truth → derives bridge type + handler signatures + preload wiring) is what matters and ports 1:1 to zod. Below I give you the pattern in **zod** as requested. If you'd rather keep inteligir's exact code, swap `z.infer` → `Static`, `schema.safeParse` → `Value.Check`, and the dep `zod` → `@sinclair/typebox`. Everything else is identical.

---

## 1. package.json deps/devDeps + versions

Inteligir pins React/TS/Vite/Tailwind via a pnpm `catalog:`. Resolved actual values below. **Phaser 4 is the only genuinely new dep** — Phaser 4.0 shipped stable late 2025; use the `^4.0.0` line.

**Node assumption:** Electron 42 bundles Node 22.x in the main process. Use Node **22 LTS** locally (`>=22`). pnpm 9+.

```jsonc
{
  "name": "office",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./.output/app/main/index.js",
  "scripts": {
    "dev": "electron-vite dev --remoteDebuggingPort 9222",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf .cache .output",
    "release": "electron-vite build && electron-builder --mac dmg --publish never",
  },
  "dependencies": {
    "phaser": "^4.0.0",
    "react": "^19.2.6",
    "react-dom": "^19.2.6",
    "zod": "^4.4.3",
  },
  "devDependencies": {
    "@electron-toolkit/tsconfig": "^2.0.0",
    "@tailwindcss/vite": "^4.3.0",
    "@types/node": "^25.9.1",
    "@types/react": "^19.2.15",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.2",
    "electron": "^42.2.0",
    "electron-builder": "^26.8.1",
    "electron-vite": "^5.0.0",
    "tailwindcss": "^4.3.0",
    "typescript": "^6.0.3",
    "vite": "^8.0.14",
  },
}
```

Notes:

- **Drop**: `electron-updater`, `sherpa-onnx-*`, `ai`, `croner`, `react-grid-layout`, `react-router`, `zustand`, `@json-render/*`, all `@repo/*` workspace pkgs. Add back `react-router`/`zustand` only if you want routing/state — not required for a single-game window.
- Tailwind is optional. Inteligir uses it (`@tailwindcss/vite` plugin + `@import` in CSS). Keep it for the React overlay UI; it does not touch the Phaser canvas. If you skip Tailwind, drop both `tailwindcss` and `@tailwindcss/vite` and the `tailwindcss()` plugin call.
- Inteligir's `vite` is on the v8 catalog line and `typescript` on v6 — those are bleeding-edge in this monorepo. If you want a more conservative footing, `vite@^7`, `typescript@^5.7` also work with `electron-vite@5`.

---

## 2. electron.vite.config.ts (adapted)

Verbatim structure from inteligir with the `sherpa-onnx-node` externalize + `PROJECT_ROOT` define removed (those were voice-native-module specific). Three sub-builds: main (ESM), preload (CJS — required because preload loads in a sandboxed context), renderer (your Vite app).

```ts
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { LibraryFormats } from "vite";

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig(() => ({
  main: {
    resolve: {
      alias: { "@": resolve(configDir, "src") },
    },
    build: {
      outDir: ".output/app/main",
      rollupOptions: {
        external: ["electron"],
        input: { index: resolve(configDir, "src/main/index.ts") },
      },
    },
  },
  preload: {
    resolve: {
      alias: { "@": resolve(configDir, "src") },
    },
    build: {
      outDir: ".output/app/preload",
      lib: {
        entry: resolve(configDir, "src/preload/index.ts"),
        formats: ["cjs"] satisfies LibraryFormats[],
      },
      rollupOptions: {
        external: ["electron"],
        output: { entryFileNames: "index.js" },
      },
    },
  },
  renderer: {
    plugins: [tailwindcss(), react()],
    resolve: {
      alias: { "@": resolve(configDir, "src") },
    },
    build: {
      outDir: ".output/app/renderer",
      rollupOptions: {
        input: { index: resolve(configDir, "src/renderer/index.html") },
      },
    },
  },
}));
```

If you drop Tailwind, `plugins: [react()]`.

---

## 3. Minimal file tree

```
office/
├─ package.json
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ tsconfig.json
├─ src/
│  ├─ main/
│  │  ├─ index.ts                 # window creation, lifecycle, IPC registration
│  │  └─ lib/
│  │     ├─ ipc-handler.ts        # handle() factory (typed, zod-validated)
│  │     └─ broadcast.ts          # broadcast() main→renderer
│  ├─ preload/
│  │  └─ index.ts                 # auto-builds contextBridge from registry
│  ├─ shared/
│  │  └─ ipc-registry.ts          # single source of truth: channels + zod schemas + types
│  └─ renderer/
│     ├─ index.html
│     ├─ main.tsx                 # React root
│     ├─ app.tsx                  # React UI (overlay)
│     ├─ env.d.ts                 # window.appBridge typing
│     ├─ styles.css
│     ├─ game/
│     │  └─ PhaserGame.tsx        # mounts Phaser.Game
│     └─ game/scenes/
│        └─ MainScene.ts
└─ public/                        # static assets served at root (see §6)
   └─ assets/
      ├─ tilesets/                # Limezu PNGs
      └─ tilemaps/                # Tiled .json
```

tsconfig.json (inteligir's, with the `@repo/ui` path dropped):

```jsonc
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.node.json",
  "include": ["src/**/*", "electron.vite.config.ts"],
  "compilerOptions": {
    "jsx": "react-jsx",
    "types": ["electron-vite/node"],
    "paths": { "@/*": ["./src/*"] },
  },
}
```

---

## 4. The IPC pattern (registry → bridge → handlers)

The whole trick: **one registry object** declares every channel with its kind (`invoke` / `invoke-void` / `send` / `event`), its zod payload schema, and its result/event type. From that one object you derive (a) the `window.appBridge` TypeScript type, (b) the preload bridge that auto-wires `ipcRenderer`, and (c) the `handle()` signature in main. Rename a channel once → compile error everywhere. This is inteligir's exact architecture, retyped to zod.

### `src/shared/ipc-registry.ts`

```ts
import { z } from "zod";

// ---- payload schemas (your domain) ---------------------------------------
const SaveGameSchema = z.object({ slot: z.number().int(), data: z.string() });

// ---- entry helpers: phantom fields carry result/event types --------------
type Invoke<S extends z.ZodTypeAny, R> = {
  readonly kind: "invoke";
  readonly channel: string;
  readonly payload: S;
  readonly _result: R;
};
type InvokeVoid<R> = {
  readonly kind: "invoke-void";
  readonly channel: string;
  readonly _result: R;
};
type Send<S extends z.ZodTypeAny> = {
  readonly kind: "send";
  readonly channel: string;
  readonly payload: S;
};
type Event<E> = { readonly kind: "event"; readonly channel: string; readonly _event: E };

type IpcEntry =
  | Invoke<z.ZodTypeAny, unknown>
  | InvokeVoid<unknown>
  | Send<z.ZodTypeAny>
  | Event<unknown>;

const invoke = <S extends z.ZodTypeAny, R>(channel: string, payload: S): Invoke<S, R> => ({
  kind: "invoke",
  channel,
  payload,
  _result: undefined as never,
});
const invokeVoid = <R>(channel: string): InvokeVoid<R> => ({
  kind: "invoke-void",
  channel,
  _result: undefined as never,
});
const send = <S extends z.ZodTypeAny>(channel: string, payload: S): Send<S> => ({
  kind: "send",
  channel,
  payload,
});
const event = <E>(channel: string): Event<E> => ({
  kind: "event",
  channel,
  _event: undefined as never,
});

// ---- THE REGISTRY: every channel that crosses the boundary ----------------
export const IPC = {
  // (a) renderer → main command
  saveGame: invoke<typeof SaveGameSchema, { ok: boolean }>("game:save", SaveGameSchema),
  loadGame: invoke<z.ZodNumber, { data: string | null }>("game:load", z.number().int()),

  // (b) main → renderer broadcast
  onTick: event<{ frame: number }>("game:tick"),
} as const satisfies Record<string, IpcEntry>;

type IpcRegistry = typeof IPC;
export type IpcMethod = keyof IpcRegistry;

// ---- derivations ----------------------------------------------------------
type MethodToFn<E extends IpcEntry> =
  E extends Invoke<infer S, infer R>
    ? (payload: z.infer<S>) => Promise<R>
    : E extends InvokeVoid<infer R>
      ? () => Promise<R>
      : E extends Send<infer S>
        ? (payload: z.infer<S>) => void
        : E extends Event<infer V>
          ? (listener: (event: V) => void) => () => void
          : never;

/** Shape exposed on window.appBridge. */
export type AppBridge = { [K in IpcMethod]: MethodToFn<IpcRegistry[K]> };

/** Handler signature main must implement for method K. */
export type IpcHandler<K extends IpcMethod> =
  IpcRegistry[K] extends Invoke<infer S, infer R>
    ? (payload: z.infer<S>) => R | Promise<R>
    : IpcRegistry[K] extends InvokeVoid<infer R>
      ? () => R | Promise<R>
      : IpcRegistry[K] extends Send<infer S>
        ? (payload: z.infer<S>) => void
        : never;

/** Broadcast payload type for an event method. */
export type IpcEvent<K extends IpcMethod> = IpcRegistry[K] extends Event<infer V> ? V : never;
```

### `src/preload/index.ts` (auto-constructs the bridge — inteligir verbatim, renamed)

```ts
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AppBridge } from "@/shared/ipc-registry";

function forwardEvent<T>(channel: string, listener: (data: T) => void): () => void {
  const wrapped = (_e: Electron.IpcRendererEvent, data: T) => listener(data);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const entries = Object.entries(IPC).map(([method, def]) => {
  switch (def.kind) {
    case "invoke":
      return [method, (p: unknown) => ipcRenderer.invoke(def.channel, p)] as const;
    case "invoke-void":
      return [method, () => ipcRenderer.invoke(def.channel)] as const;
    case "send":
      return [method, (p: unknown) => ipcRenderer.send(def.channel, p)] as const;
    case "event":
      return [method, (l: (e: unknown) => void) => forwardEvent(def.channel, l)] as const;
  }
});

const appBridge = Object.fromEntries(entries) as unknown as AppBridge;
contextBridge.exposeInMainWorld("appBridge", appBridge);
```

### `src/main/lib/ipc-handler.ts` (typed `handle()` — zod port of inteligir)

```ts
import { ipcMain } from "electron";
import { IPC, type IpcHandler, type IpcMethod } from "@/shared/ipc-registry";

function parsePayload(
  method: IpcMethod,
  schema: {
    safeParse: (v: unknown) => { success: boolean; error?: { message: string }; data?: unknown };
  },
  raw: unknown,
): unknown {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `[ipc:${method}] payload validation failed — ${result.error?.message ?? "shape mismatch"}`,
    );
  }
  return result.data;
}

export function handle<K extends IpcMethod>(method: K, fn: IpcHandler<K>): void {
  const def = IPC[method];
  switch (def.kind) {
    case "invoke":
      ipcMain.handle(def.channel, (_e, raw: unknown) =>
        (fn as (p: unknown) => unknown)(parsePayload(method, def.payload, raw)),
      );
      return;
    case "invoke-void":
      ipcMain.handle(def.channel, () => (fn as () => unknown)());
      return;
    case "send":
      ipcMain.on(def.channel, (_e, raw: unknown) => {
        try {
          (fn as (p: unknown) => void)(parsePayload(method, def.payload, raw));
        } catch (err) {
          console.error(`[ipc] send "${method}" failed:`, err);
        }
      });
      return;
    case "event":
      throw new Error(`"${method}" is event-only; use broadcast()`);
  }
}
```

### `src/main/lib/broadcast.ts` (main → renderer — inteligir verbatim, renamed)

```ts
import { BrowserWindow } from "electron";
import { IPC, type IpcEvent, type IpcMethod } from "@/shared/ipc-registry";

type EventMethod = {
  [K in IpcMethod]: (typeof IPC)[K] extends { kind: "event" } ? K : never;
}[IpcMethod];

export function broadcast<K extends EventMethod>(method: K, data: IpcEvent<K>): void {
  const def = IPC[method];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(def.channel, data);
  }
}
```

### Concrete usage

**(a) renderer invokes a main command:**

```ts
// renderer
const res = await window.appBridge?.saveGame({ slot: 1, data: "..." }); // res: { ok: boolean }
```

```ts
// src/main/index.ts — inside registerIpcHandlers()
handle("saveGame", ({ slot, data }) => {
  writeSlot(slot, data);
  return { ok: true };
});
```

**(b) main broadcasts an event:**

```ts
// main — anywhere
broadcast("onTick", { frame: 42 });
```

```ts
// renderer — subscribe, returns unsubscribe
useEffect(() => window.appBridge?.onTick(({ frame }) => console.log(frame)), []);
```

### `src/main/index.ts` (skeleton — window + lifecycle, inteligir distilled)

Key bits to keep from inteligir: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, preload path join, `ready-to-show` gate, dev-URL-vs-loadFile branch, `setWindowOpenHandler` to deny in-app nav.

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, shell } from "electron";
import { handle } from "@/main/lib/ipc-handler";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;

function registerIpcHandlers(): void {
  handle("saveGame", ({ slot, data }) => {
    /* writeSlot */ return { ok: true };
  });
  handle("loadGame", (slot) => ({ data: /* readSlot(slot) */ null }));
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(moduleDir, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.once("ready-to-show", () => win.show());
  if (isDev && process.env["ELECTRON_RENDERER_URL"])
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  else void win.loadFile(path.join(moduleDir, "../renderer/index.html"));
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

app.whenReady().then(() => {
  registerIpcHandlers();
  mainWindow = createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

---

## 5. Mount Phaser inside a React component

Best practice (matches your note): create `Phaser.Game` **once** in `useEffect`, give it a container `<div>` via ref, destroy on unmount. React UI sits as an absolutely-positioned overlay above the canvas — never re-render the canvas through React. Guard against StrictMode's double-invoke (which inteligir runs — see `main.tsx`'s `<StrictMode>`) with a ref so you don't spawn two games.

`src/renderer/game/PhaserGame.tsx`:

```tsx
import { useEffect, useRef } from "react";
import Phaser from "phaser";
import { MainScene } from "./scenes/MainScene";

export function PhaserGame() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (gameRef.current || !containerRef.current) return; // StrictMode double-mount guard

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      width: 1280,
      height: 800,
      pixelArt: true, // crisp Limezu pixel tiles, no smoothing
      scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene: [MainScene],
    });
    gameRef.current = game;

    return () => {
      game.destroy(true); // remove canvas + free WebGL context
      gameRef.current = null;
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
      {/* React overlay — pointer-events-none lets clicks fall through to canvas;
          re-enable on interactive children */}
      <div className="pointer-events-none absolute inset-0 z-10">
        {/* HUD, menus, dialogs here */}
      </div>
    </div>
  );
}
```

`src/renderer/game/scenes/MainScene.ts`:

```ts
import Phaser from "phaser";

export class MainScene extends Phaser.Scene {
  constructor() {
    super("main");
  }

  preload() {
    this.load.image("tiles", "assets/tilesets/limezu-interior.png");
    this.load.tilemapTiledJSON("map", "assets/tilemaps/office.json");
  }

  create() {
    const map = this.make.tilemap({ key: "map" });
    const tileset = map.addTilesetImage("limezu-interior", "tiles");
    if (tileset) map.createLayer("Ground", tileset, 0, 0);
  }
}
```

Mount it from `app.tsx` (replacing inteligir's router/shell):

```tsx
import { PhaserGame } from "@/renderer/game/PhaserGame";
export function App() {
  return <PhaserGame />;
}
```

`main.tsx` stays inteligir's shape minus the router/flush-bridge:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/renderer/app";
import "./styles.css";

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
```

`index.html` unchanged from inteligir (`<div id="root">` + `<script type="module" src="./main.tsx">`). Keep `styles.css`'s `html,body,#root { width/height:100%; overflow:hidden }` — Phaser needs a sized parent.

Bridge typing — `src/renderer/env.d.ts`:

```ts
declare module "*.css";
interface Window {
  appBridge?: import("@/shared/ipc-registry").AppBridge;
}
```

---

## 6. How Vite references/bundles renderer assets — where Limezu PNGs go

Two mechanisms, pick per asset:

- **`public/` (recommended for game assets)** — files in `public/` are copied **as-is, unhashed, served at the web root**. Reference by absolute-ish runtime string: `this.load.image("tiles", "assets/tilesets/foo.png")` resolves against the renderer base. This is the right home for Limezu PNGs and Tiled `.json` tilemaps because Phaser loads them at runtime by **string path** (not ES import), and Tiled JSON internally references tileset image filenames — those must stay stable/unhashed or the relative refs break. Put them in `office/public/assets/{tilesets,tilemaps}/`.

  Gotcha: `electron-vite`'s renderer is just Vite with `base` adjusted for `file://` loading in production. Public assets land at `.output/app/renderer/assets/...` and load fine via `loadFile`. Use **root-relative without a leading slash** (`"assets/..."`) so it works under both the dev server and the `file://` packaged build. Avoid a leading `/` — that breaks under `file://`.

- **`import` (for hashed, build-tracked assets)** — `import url from "./foo.png?url"` (inteligir declares `*?url` in its `env.d.ts`) gives a hashed, content-addressed URL. Good for one-off UI sprites bundled into the JS graph, icons, etc. Not ideal for the bulk tilemap set since you'd have to import each PNG and rewrite the Tiled JSON's image refs.

Rule of thumb: **bulk game data (tilesets + tilemaps) → `public/`; incidental UI imagery → `import ... ?url`.**

Also list `public/**` or `assets/**` in `electron-builder.yml` `files:` (see §7) so they ship in the asar.

---

## 7. Native-module / electron-rebuild gotchas — and your save store

**The big lesson from inteligir:** native `.node` addons are painful in Electron. Inteligir's entire `electron-builder.yml` complexity (the `!node_modules/**` exclude + selective re-include, `asarUnpack`, `npmRebuild: false`, externalizing `sherpa-onnx-node` in the vite config) exists **only** to ship one native module. You do not want that tax for a save file.

- **better-sqlite3** is a native addon compiled against Node's ABI. In Electron it's compiled against **Electron's** ABI, which differs → you'd need `electron-rebuild` (or electron-builder's `npmRebuild`) on every install, per platform/arch, and `.node` files **cannot be `require()`'d from inside an asar** (inteligir's comment confirms — they `asarUnpack` the whole tree). That's real ongoing friction for cross-platform CI/notarization.

- **`node:sqlite`** (the built-in, stable in Node 22.5+) — Electron 42 ships Node 22, so it's present in the **main** process with **zero native-rebuild**. Good option if you genuinely need SQL. Caveat: it's only in main (Node), so all DB access must go through your IPC `handle()` layer — which you have anyway. Verify availability on your exact Electron build before committing (`require("node:sqlite")` in main).

- **Pure-JS store (recommended for a game save)** — for slot-based save data you don't need SQL at all. **Reuse inteligir's `JsonStore`** (`src/main/lib/json-store.ts`) almost verbatim: atomic temp-write-then-rename, schema validation on read, corrupt-file recovery to `.corrupt-<ts>`, in-memory cache. Port its `@sinclair/typebox` validation to zod (`schema.safeParse` instead of `Value.Check`) to match your stack. Zero native deps, zero rebuild, survives crashes mid-write. This is the lowest-friction path and what I'd ship.

**Because you have no native modules, your `electron-builder.yml` simplifies dramatically** — drop the `node_modules` exclude/re-include dance, `asarUnpack` of native trees, and the vite `external` list. Minimal:

```yaml
appId: com.office.desktop
productName: Office
directories:
  buildResources: resources
  output: .output/bin
files:
  - .output/app/**/*
  - package.json
mac:
  category: public.app-category.games
  icon: resources/icon.icns
npmRebuild: false # no native modules → nothing to rebuild
```

(`phaser`, `react`, `zod` are all pure JS and get tree-shaken into the bundle by electron-vite, so they never need to live in `node_modules` at runtime — hence no `node_modules` entry in `files:` at all.)

---

## Unresolved questions

- Tailwind in? Keep for overlay HUD, or drop (pure Phaser UI)?
- Pin bleeding-edge versions (vite 8 / ts 6 from inteligir catalog) or conservative (vite 7 / ts 5.7)?
- Save store: confirm pure-JS `JsonStore` (recommend) vs `node:sqlite` — do you actually need queries?
- Multiple scenes / a preloader scene now, or single `MainScene` to start?
- Window: fixed game resolution (letterbox) or RESIZE-to-fit? Affects Phaser scale mode + window `resizable`.
- zod confirmed over inteligir's native typebox? (I built §4 in zod per your ask.)

**Relevant source files read:**
`/Users/kyh/Documents/Projects/inteligir/apps/desktop/{package.json, electron.vite.config.ts, electron-builder.yml, tsconfig.json}`, `src/main/index.ts`, `src/main/lib/{ipc-handler.ts, broadcast.ts, json-store.ts}`, `src/preload/index.ts`, `src/shared/{ipc-registry.ts, ipc.ts}`, `src/renderer/{main.tsx, app.tsx, index.html, env.d.ts, styles.css}`.
