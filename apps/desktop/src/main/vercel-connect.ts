import { deleteSecret, setSecret } from "@/main/secrets";
import * as store from "@/main/store/store";
import { listProjects, validateToken } from "@/main/vercel";
import type { Contract } from "@/shared/ipc-registry";

// ---------------------------------------------------------------------------
// The Vercel link, beside its Stripe twin (stripe-connect.ts): one personal
// token per founder lands in secrets.json as VERCEL_TOKEN, and each product
// binds its own project. The metrics pulse (users = Web Analytics visitors,
// per product) and the agents' shells (real deploys via the vercel CLI) inherit
// the token from there.
// ---------------------------------------------------------------------------

const VERCEL_TOKEN_KEY = "VERCEL_TOKEN";

let onConnected: () => void = () => {};

export function initVercelConnect(hooks: { onConnected: () => void }): void {
  onConnected = hooks.onConnected;
}

export async function listVercelProjects(
  token: string,
): Promise<Contract["vercelListProjects"]["result"]> {
  const check = await validateToken(token.trim());
  if (!check.ok) return { ok: false, projects: [] };
  const projects = await listProjects(token.trim());
  return { ok: true, account: check.account, projects };
}

export function connectVercel(input: Contract["vercelConnect"]["payload"]): void {
  const { productId, token, projectId, projectName, teamId } = input;
  setSecret(VERCEL_TOKEN_KEY, token.trim());
  store.setProductVercel(productId, { projectId, projectName, teamId: teamId ?? null });
  onConnected();
}

/** Unbind the product; the token goes too once no product is bound to anything. */
export function disconnectVercel(productId: string): void {
  const product = store.setProductVercel(productId, null);
  if (!product) return;
  const stillBound = store.listProducts(product.companyId).some((p) => p.vercel !== null);
  if (!stillBound) deleteSecret(VERCEL_TOKEN_KEY);
}
