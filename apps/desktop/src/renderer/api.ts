// How the page reaches the server: the server serves this page itself
// (apps/cli/src/server/page-server.ts), so the page calls the contract's procedures (oRPC, at
// RPC_PREFIX), its event stream among them (page-events.ts), on its own origin, signed in by the
// cookie its handoff link set, whether it is the app's window, a browser under `pnpm dev:browser`
// or e2e's Chromium. A refusal arrives as the error the call throws, worded as the founder reads it
// (apps/cli/src/server/lib/answers.ts). What the page reads of main it holds in one query cache
// (state/queries.ts), keyed by `orpc`.

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { Contract } from "@repo/contract/contract";
import { RPC_PREFIX } from "@repo/contract/routes";

export type Api = ContractRouterClient<Contract>;

/** The server's procedures. No headers: the page holds no bearer, and its cookie rides along. */
export const api: Api = createORPCClient(new RPCLink({ url: RPC_PREFIX }));

/** The procedures as tanstack-query options and keys, each key the procedure's path and input. */
export const orpc = createTanstackQueryUtils(api);
