import { VERCEL_TOKEN } from "./vault/names";
import { getSecret, setSecret } from "./vault/vault";
import * as store from "./store/store";
import { listProjects, validateToken } from "./vercel";
import { errorMessage } from "@repo/domain/errors";
import type { z } from "zod";
import type { connectInput, saveTokenInput } from "@repo/contract/vercel-contract";
import type { VercelListing } from "@repo/domain/integrations";

// One token per founder; each product binds its own project.

/**
 * What a connection gives the asks waiting on Vercel. The first token saved is what every
 * product's deploy lacked, whichever product it came through; after that, a binding or a new
 * token answers only its own product.
 */
export type VercelConnection = { kind: "token" } | { kind: "product"; productId: string };

const saveToken = async (
  productId: string,
  token: string | undefined,
): Promise<VercelConnection> => {
  if (token === undefined) {
    return { kind: "product", productId };
  }
  const first = getSecret(VERCEL_TOKEN) === null;
  await setSecret(VERCEL_TOKEN, token);
  return first ? { kind: "token" } : { kind: "product", productId };
};

/** The projects `token` can see, or the saved token's when none is given. */
export const listVercelProjects = async (token?: string): Promise<VercelListing> => {
  const key = token ?? getSecret(VERCEL_TOKEN);
  if (!key) {
    return { kind: "refused" };
  }
  try {
    const check = await validateToken(key);
    if (check.kind === "refused") {
      return check;
    }
    return { account: check.account, kind: "loaded", projects: await listProjects(key) };
  } catch (error) {
    return { kind: "unreachable", reason: errorMessage(error) };
  }
};

export const connectVercel = async (
  input: z.infer<typeof connectInput>,
): Promise<VercelConnection> => {
  const { productId, token, projectId, projectName, teamId } = input;
  store.requireProduct(productId);
  const connection = await saveToken(productId, token);
  store.setProductVercel(productId, { projectId, projectName, teamId: teamId ?? null });
  return connection;
};

/** Save a token with no project picked: the product's first deploy makes one named after it and binds it. */
export const saveVercelToken = async ({
  productId,
  token,
}: z.infer<typeof saveTokenInput>): Promise<VercelConnection> => {
  store.requireProduct(productId);
  return await saveToken(productId, token);
};

export const disconnectVercel = (productId: string): void => {
  // the token is the founder's, which every product deploys with, so unbinding one keeps it
  store.setProductVercel(productId, null);
};
