// Where the page reaches the server: on the page's own origin, which the server serves
// (apps/cli/src/server/page-server.ts), so the app's window, a browser under `pnpm dev:browser` and
// e2e's Chromium all call it the same way.

/** The contract's procedures (contract.ts), as oRPC's RPC protocol mounts them. */
export const RPC_PREFIX = "/rpc";

/** The server's events (events.ts), one server-sent stream, each under its name. */
export const EVENTS_PATH = "/events";

/** The query parameter a handoff link carries its one-time nonce in. */
export const HANDOFF_PARAM = "handoff";

/** Vite's dev server: the page's files under `tauri dev` and `pnpm dev:browser`. */
export const DEV_PORT = 31_100;
