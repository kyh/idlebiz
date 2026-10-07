// How the page reaches the server: the server serves this page itself
// (apps/cli/src/server/page-server.ts), so the page calls the contract's procedures (oRPC, at
// RPC_PREFIX) and hears its events (one server-sent stream, at EVENTS_PATH) on its own origin,
// signed in by the cookie its handoff link set, whether it is the app's window, a browser under
// `pnpm dev:browser` or e2e's Chromium. A refusal arrives as the error the call throws, worded as
// the founder reads it (apps/cli/src/server/lib/answers.ts). install-api.ts builds both.

import type { ContractRouterClient } from "@orpc/contract";
import type { Contract } from "@repo/contract/contract";
import type { PageEvent, PageEvents } from "@repo/contract/events";

export type Api = ContractRouterClient<Contract>;

/** Hears one of the server's events until the answer it gives is called. */
export type Listen = <E extends PageEvent>(
  event: E,
  listener: (data: PageEvents[E]) => void,
) => () => void;

export interface AppApi {
  api: Api;
  listen: Listen;
}

declare global {
  // install-api.ts sets it on the window, which is the page's globalThis; declared here rather than
  // on Window so code under test in node can name it, and a test can stub it
  var appApi: AppApi | undefined;
}

const installed = (): AppApi => {
  const app = globalThis.appApi;
  if (!app) {
    throw new Error("the page's API is not installed");
  }
  return app;
};

/** The server's procedures. */
export const api = (): Api => installed().api;

/** Hears one of the server's events. */
export const listen: Listen = (event, listener) => installed().listen(event, listener);
