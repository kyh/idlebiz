// Where the window's page reaches main: main's own page server (apps/cli/src/server/page-server.ts), on the
// page's own origin, so the app's window, a browser under `pnpm dev:browser` and e2e's Chromium all
// call main the same way.

/** Main's answer to the page's calls: POST `{method, payload?}`, answered with main's reply. */
export const INVOKE_PATH = "/__idlebiz/invoke";

/** Main's events, one server-sent stream, each under its channel's name. */
export const EVENTS_PATH = "/__idlebiz/events";

/** Main's own paths on the page's origin, which no file of the page is named under. */
export const MAIN_PATHS = "/__idlebiz/";

/** The query parameter a handoff link carries its one-time nonce in. */
export const HANDOFF_PARAM = "handoff";

/** Vite's dev server: the page's files under `tauri dev` and `pnpm dev:browser`. */
export const DEV_PORT = 31_100;
