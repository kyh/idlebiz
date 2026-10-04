// Where a browser reaches main in development (`pnpm dev:browser`): the dev server's own origin,
// under one path, behind a token the page reads from its URL's fragment (src/dev-host/host.ts).
// The seal closes the dev server's port to every employee run (src/main/agents/seal.ts).

/** The dev server the page is served from, to `tauri dev`'s window and to a browser alike. */
export const DEV_PORT = 31_100;

/** The bridge's paths on that origin: `invoke` and the `events` stream. */
export const DEV_BRIDGE_PATH = "/__idlebiz";
