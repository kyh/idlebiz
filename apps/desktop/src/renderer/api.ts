// How the page reaches main: the contract's procedures, on the page's own origin.

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterContractClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { Contract } from "@repo/contract/contract";
import { RPC_PREFIX } from "@repo/contract/routes";

export type Api = RouterContractClient<Contract>;

/** No headers: the page holds no bearer, and its cookie rides along. */
export const api: Api = createORPCClient(new RPCLink({ url: RPC_PREFIX }));

/** The procedures as tanstack-query options and keys, each key the procedure's path and input. */
export const orpc = createTanstackQueryUtils(api);
