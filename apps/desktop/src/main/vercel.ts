import { z } from "zod";
import { getJson } from "@/main/lib/http";
import type { JsonValue } from "@/shared/json";
import { getSecret } from "@/main/secrets";
import type { VercelDeployment, VercelProject } from "@/shared/ipc-registry";

const API = "https://api.vercel.com";

const apiGet = (
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<JsonValue> => {
  const qs = new URLSearchParams(params).toString();
  return getJson(
    `${API}${path}${qs ? `?${qs}` : ""}`,
    { Authorization: `Bearer ${token}` },
    10_000,
  );
};

const UserSchema = z.object({
  user: z.object({ name: z.string().nullish(), username: z.string().optional() }),
});

export const validateToken = async (token: string): Promise<{ ok: boolean; account?: string }> => {
  try {
    const parsed = UserSchema.safeParse(await apiGet("/v2/user", token));
    if (!parsed.success) {
      return { ok: true };
    }
    return { account: parsed.data.user.name ?? parsed.data.user.username, ok: true };
  } catch {
    return { ok: false };
  }
};

const ProjectsSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});
const TeamsSchema = z.object({
  teams: z.array(z.object({ id: z.string(), name: z.string().nullish() })).default([]),
});

/** Projects across the personal account and every team the token can see. */
export const listProjects = async (token: string): Promise<VercelProject[]> => {
  const out: VercelProject[] = [];
  const personal = ProjectsSchema.safeParse(await apiGet("/v9/projects", token, { limit: "100" }));
  if (personal.success) {
    out.push(...personal.data.projects.map((p) => ({ id: p.id, name: p.name })));
  }
  try {
    const teams = TeamsSchema.safeParse(await apiGet("/v2/teams", token, { limit: "20" }));
    if (teams.success) {
      const perTeam = await Promise.all(
        teams.data.teams.map(async (team) => {
          const projs = ProjectsSchema.safeParse(
            await apiGet("/v9/projects", token, { limit: "100", teamId: team.id }),
          );
          if (!projs.success) {
            return [];
          }
          return projs.data.projects.map((p) => ({ id: p.id, name: p.name, teamId: team.id }));
        }),
      );
      out.push(...perTeam.flat());
    }
  } catch {
    /* personal-only token */
  }
  return out;
};

const VisitsCountSchema = z.object({
  data: z.object({ pageviews: z.number().optional(), visitors: z.number().optional() }),
});

/** Prefer 30-day visitors; fall back to the production total if the dated query fails. */
export const webAnalyticsVisitors = async (
  projectId: string,
  teamId?: string,
): Promise<number | null> => {
  const token = getSecret("VERCEL_TOKEN");
  if (!token) {
    return null;
  }
  const base: Record<string, string> = teamId ? { projectId, teamId } : { projectId };
  const since = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString().slice(0, 10);
  for (const params of [{ ...base, since }, base]) {
    try {
      const parsed = VisitsCountSchema.safeParse(
        await apiGet("/v1/query/web-analytics/visits/count", token, params),
      );
      if (parsed.success && parsed.data.data.visitors !== undefined) {
        return parsed.data.data.visitors;
      }
    } catch {
      /* try the next parameter shape */
    }
  }
  return null;
};

const DeploymentsSchema = z.object({
  deployments: z
    .array(
      z.object({
        created: z.number().optional(),
        createdAt: z.number().optional(),
        readyState: z.string().optional(),
        state: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .default([]),
});

// Deploy state changes rarely but is asked for on every renderer refresh
// (each run end) — cache per project so bursts don't hammer the API.
const DEPLOY_CACHE_TTL_MS = 60_000;
const deployCache = new Map<string, { at: number; value: VercelDeployment | null }>();

/** The latest production deployment — the product panel's "LIVE" state. */
export const latestDeployment = async (
  projectId: string,
  teamId?: string,
): Promise<VercelDeployment | null> => {
  const token = getSecret("VERCEL_TOKEN");
  if (!token) {
    return null;
  }
  const cached = deployCache.get(projectId);
  if (cached && Date.now() - cached.at < DEPLOY_CACHE_TTL_MS) {
    return cached.value;
  }
  const params: Record<string, string> = teamId
    ? { limit: "1", projectId, target: "production", teamId }
    : { limit: "1", projectId, target: "production" };
  let value: VercelDeployment | null = null;
  try {
    const parsed = DeploymentsSchema.safeParse(await apiGet("/v6/deployments", token, params));
    const d = parsed.success ? parsed.data.deployments[0] : undefined;
    if (d?.url) {
      value = {
        createdAt: d.createdAt ?? d.created ?? 0,
        state: d.state ?? d.readyState ?? "UNKNOWN",
        url: `https://${d.url}`,
      };
    }
  } catch {
    /* unreachable — treat as no deployment, retry after the TTL */
  }
  deployCache.set(projectId, { at: Date.now(), value });
  return value;
};
