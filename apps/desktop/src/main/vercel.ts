import { z } from "zod";
import { getJson } from "@/main/lib/http";
import type { JsonValue } from "@/shared/json";
import { getSecret } from "@/main/secrets";
import type { VercelDeployment, VercelProject } from "@/shared/integrations";

const API = "https://api.vercel.com";

const apiGet = (
  path: string,
  token: string,
  params: Readonly<Record<string, string | undefined>> = {},
): Promise<JsonValue> => {
  const given = Object.entries(params).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const qs = new URLSearchParams(given).toString();
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

/** Which visits to count. Left empty, it is every visit the project has ever had. */
export interface VisitWindow {
  /** Only visits from this moment on. */
  since?: number;
  /** Only visits to this path or anything under it. */
  under?: string;
}

/**
 * The query for a count of visitors. The API wants `since` and `until` together
 * or neither, and filters in OData; path filters are on every plan, the utm ones
 * are a paid add-on, which is why a bet marks its traffic with a path.
 */
export interface VisitQuery {
  projectId: string;
  teamId?: string;
  since?: string;
  until?: string;
  filter?: string;
}

export const visitQuery = (
  project: { projectId: string; teamId: string | null },
  window: VisitWindow,
  now: number,
): VisitQuery => {
  const params: VisitQuery = { projectId: project.projectId };
  if (project.teamId !== null) {
    params.teamId = project.teamId;
  }
  if (window.since !== undefined) {
    params.since = new Date(window.since).toISOString();
    params.until = new Date(now).toISOString();
  }
  if (window.under !== undefined) {
    const path = window.under.replaceAll("'", "''");
    const below = path.endsWith("/") ? path : `${path}/`;
    params.filter = `requestPath eq '${path}' or startswith(requestPath, '${below}')`;
  }
  return params;
};

/** Visitors to a product's deploy, from the Web Analytics the dashboard reads. */
export const webAnalyticsVisitors = async (
  project: { projectId: string; teamId: string | null },
  window: VisitWindow = {},
): Promise<number | null> => {
  const token = getSecret("VERCEL_TOKEN");
  if (!token) {
    return null;
  }
  try {
    const parsed = VisitsCountSchema.safeParse(
      await apiGet("/v1/query/web-analytics/visits/count", token, {
        ...visitQuery(project, window, Date.now()),
      }),
    );
    return parsed.success ? (parsed.data.data.visitors ?? null) : null;
  } catch {
    return null;
  }
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
