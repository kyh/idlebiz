import { readMetricsConfig, writeMetricsConfig } from "@/main/metrics";
import { deleteSecret, getSecret, setSecret } from "@/main/secrets";
import { listProjects, validateToken } from "@/main/vercel";
import type { Contract, VercelStatus } from "@/shared/ipc-registry";

// ---------------------------------------------------------------------------
// The Vercel link, beside its Stripe twin (stripe-connect.ts): a personal
// token lands in secrets.json as VERCEL_TOKEN and the chosen project in
// metrics.json. Both the metrics pulse (users = Web Analytics visitors) and the
// agents' shells (real deploys via the vercel CLI) inherit it from there.
// ---------------------------------------------------------------------------

const VERCEL_TOKEN_KEY = "VERCEL_TOKEN";

let onConnected: () => void = () => {};

export function initVercelConnect(hooks: { onConnected: () => void }): void {
  onConnected = hooks.onConnected;
}

export function getVercelStatus(companyId: string): VercelStatus {
  const cfg = readMetricsConfig(companyId);
  if (!cfg?.vercel || !getSecret(VERCEL_TOKEN_KEY)) return { state: "disconnected" };
  return { state: "connected", projectName: cfg.vercel.projectName ?? cfg.vercel.projectId };
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
  const { companyId, token, projectId, projectName, teamId } = input;
  setSecret(VERCEL_TOKEN_KEY, token.trim());
  writeMetricsConfig(companyId, {
    vercel: teamId ? { projectId, projectName, teamId } : { projectId, projectName },
  });
  onConnected();
}

export function disconnectVercel(companyId: string): void {
  writeMetricsConfig(companyId, { vercel: undefined });
  deleteSecret(VERCEL_TOKEN_KEY);
}
