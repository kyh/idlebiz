import { getSecret, setSecret } from "@/main/secrets";
import * as store from "@/main/store/store";
import { listProjects, validateToken } from "@/main/vercel";
import { errorMessage } from "@/shared/errors";
import type { Contract } from "@/shared/ipc-registry";

// One token per founder; each product binds its own project.

const VERCEL_TOKEN_KEY = "VERCEL_TOKEN";

let onConnected: () => void = () => {
  /* empty */
};

export const initVercelConnect = (hooks: { onConnected: () => void }): void => {
  ({ onConnected } = hooks);
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
  if (token !== undefined) {
    setSecret(VERCEL_TOKEN_KEY, token);
  }
  store.setProductVercel(productId, { projectId, projectName, teamId: teamId ?? null });
  onConnected();
};

export const disconnectVercel = (productId: string): void => {
  // Older saves may still use the founder's shared token.
  store.setProductVercel(productId, null);
};
