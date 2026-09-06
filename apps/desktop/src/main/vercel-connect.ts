import { setSecret } from "@/main/secrets";
import * as store from "@/main/store/store";
import { listProjects, validateToken } from "@/main/vercel";
import type { Contract } from "@/shared/ipc-registry";

// One token per founder; each product binds its own project.

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
  store.requireProduct(productId);
  setSecret(VERCEL_TOKEN_KEY, token.trim());
  store.setProductVercel(productId, { projectId, projectName, teamId: teamId ?? null });
  onConnected();
}

export function disconnectVercel(productId: string): void {
  store.requireProduct(productId);
  // Older saves may still use the founder's shared token.
  store.setProductVercel(productId, null);
}
