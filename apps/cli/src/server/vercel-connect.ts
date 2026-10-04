import { getSecret, setSecret } from "./secrets";
import * as store from "./store/store";
import { listProjects, validateToken } from "./vercel";
import { errorMessage } from "@repo/domain/errors";
import type { Contract } from "@repo/contract/ipc-registry";

// One token per founder; each product binds its own project.

const VERCEL_TOKEN_KEY = "VERCEL_TOKEN";

/**
 * What a connection gives the asks waiting on Vercel. The first token saved is what every
 * product's deploy lacked, whichever product it came through; after that, a binding or a new
 * token answers only its own product.
 */
export type VercelConnection = { kind: "token" } | { kind: "product"; productId: string };

let onConnected: (connection: VercelConnection) => void = () => {
  /* empty */
};

export const initVercelConnect = (hooks: {
  onConnected: (connection: VercelConnection) => void;
}): void => {
  ({ onConnected } = hooks);
};

const saveToken = (productId: string, token: string | undefined): VercelConnection => {
  if (token === undefined) {
    return { kind: "product", productId };
  }
  const first = getSecret(VERCEL_TOKEN_KEY) === null;
  setSecret(VERCEL_TOKEN_KEY, token);
  return first ? { kind: "token" } : { kind: "product", productId };
};

/** The projects `token` can see, or the saved token's when none is given. */
export const listVercelProjects = async (
  token?: string,
): Promise<Contract["vercelListProjects"]["result"]> => {
  const key = token ?? getSecret(VERCEL_TOKEN_KEY);
  if (!key) {
    return { kind: "rejected" };
  }
  try {
    const check = await validateToken(key);
    if (check.kind === "rejected") {
      return check;
    }
    return { account: check.account, kind: "loaded", projects: await listProjects(key) };
  } catch (error) {
    return { kind: "unreachable", reason: errorMessage(error) };
  }
};

export const connectVercel = (input: Contract["vercelConnect"]["payload"]): void => {
  const { productId, token, projectId, projectName, teamId } = input;
  store.requireProduct(productId);
  const connection = saveToken(productId, token);
  store.setProductVercel(productId, { projectId, projectName, teamId: teamId ?? null });
  onConnected(connection);
};

/** Save a token with no project picked: the product's first deploy makes one named after it and binds it. */
export const saveVercelToken = ({
  productId,
  token,
}: Contract["vercelSaveToken"]["payload"]): void => {
  store.requireProduct(productId);
  onConnected(saveToken(productId, token));
};

export const disconnectVercel = (productId: string): void => {
  // Older saves may still use the founder's shared token.
  store.setProductVercel(productId, null);
};
