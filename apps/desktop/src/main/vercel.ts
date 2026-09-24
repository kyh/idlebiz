import { z } from "zod";
import { getJson, HttpError } from "@/main/lib/http";
import type { JsonValue } from "@/shared/json";
import { getSecret } from "@/main/secrets";
import type { DeployRead, VercelProject } from "@/shared/integrations";

export const VERCEL_API = "https://api.vercel.com";

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
    `${VERCEL_API}${path}${qs ? `?${qs}` : ""}`,
    { Authorization: `Bearer ${token}` },
    10_000,
  );
};

/** `apiGet`'s answer, or null when Vercel refuses the token this call; anything else still throws. */
const apiGetUnlessRefused = async (
  path: string,
  token: string,
  params: Readonly<Record<string, string | undefined>> = {},
): Promise<JsonValue | null> => {
  try {
    return await apiGet(path, token, params);
  } catch (error) {
    if (error instanceof HttpError && error.refused) {
      return null;
    }
    throw error;
  }
};

const UserSchema = z.object({
  user: z.object({ name: z.string().nullish(), username: z.string().optional() }),
});

/** Whether Vercel takes `token`; throws when Vercel cannot be asked. */
export const validateToken = async (
  token: string,
): Promise<{ kind: "rejected" } | { kind: "valid"; account: string | undefined }> => {
  const answer = await apiGetUnlessRefused("/v2/user", token);
  if (answer === null) {
    return { kind: "rejected" };
  }
  const parsed = UserSchema.safeParse(answer);
  return {
    account: parsed.success ? (parsed.data.user.name ?? parsed.data.user.username) : undefined,
    kind: "valid",
  };
};

const ProjectsSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});
const TeamsSchema = z.object({
  teams: z
    .array(z.object({ id: z.string(), name: z.string().nullish(), slug: z.string().optional() }))
    .default([]),
});

/**
 * Projects across the personal account and every team the token can see. A
 * token scoped to some of them is refused the rest, which lists fewer projects;
 * any other failure throws, so one team being down never shortens the list.
 */
export const listProjects = async (token: string): Promise<VercelProject[]> => {
  const out: VercelProject[] = [];
  const personal = ProjectsSchema.safeParse(
    await apiGetUnlessRefused("/v9/projects", token, { limit: "100" }),
  );
  if (personal.success) {
    out.push(...personal.data.projects.map((p) => ({ id: p.id, name: p.name })));
  }
  const teams = TeamsSchema.safeParse(
    await apiGetUnlessRefused("/v2/teams", token, { limit: "20" }),
  );
  if (teams.success) {
    const perTeam = await Promise.all(
      teams.data.teams.map(async (team) => {
        const projs = ProjectsSchema.safeParse(
          await apiGetUnlessRefused("/v9/projects", token, { limit: "100", teamId: team.id }),
        );
        if (!projs.success) {
          return [];
        }
        return projs.data.projects.map((p) => ({
          id: p.id,
          name: p.name,
          teamId: team.id,
          teamName: team.name ?? team.slug,
        }));
      }),
    );
    out.push(...perTeam.flat());
  }
  // The personal listing can repeat a team's projects; the team's listing wins,
  // since its teamId reaches the project whatever the token's default scope.
  return [...new Map(out.map((p) => [p.id, p])).values()];
};

const VisitsCountSchema = z.object({
  data: z.object({ pageviews: z.number().optional(), visitors: z.number().optional() }),
});

/** Which visits to count. Left empty, it is every visit the project has ever had. */
export interface VisitWindow {
  /** Only visits between these moments. */
  span?: { since: number; until: number };
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
): VisitQuery => {
  const params: VisitQuery = { projectId: project.projectId };
  if (project.teamId !== null) {
    params.teamId = project.teamId;
  }
  if (window.span !== undefined) {
    params.since = new Date(window.span.since).toISOString();
    params.until = new Date(window.span.until).toISOString();
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
        ...visitQuery(project, window),
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
// (each run end) — cache per project so bursts don't hammer the API. An entry
// holds only for the token that read it, so a reconnect is seen at once.
const DEPLOY_CACHE_TTL_MS = 60_000;
const deployCache = new Map<string, { at: number; token: string; read: DeployRead }>();

/** The latest production deployment — the product panel's "LIVE" state. */
export const latestDeployment = async (projectId: string, teamId?: string): Promise<DeployRead> => {
  const token = getSecret("VERCEL_TOKEN");
  if (!token) {
    return { kind: "none" };
  }
  const cached = deployCache.get(projectId);
  if (cached && cached.token === token && Date.now() - cached.at < DEPLOY_CACHE_TTL_MS) {
    return cached.read;
  }
  const params: Record<string, string> = teamId
    ? { limit: "1", projectId, target: "production", teamId }
    : { limit: "1", projectId, target: "production" };
  let read: DeployRead = { kind: "none" };
  try {
    const parsed = DeploymentsSchema.safeParse(await apiGet("/v6/deployments", token, params));
    const d = parsed.success ? parsed.data.deployments[0] : undefined;
    if (d?.url) {
      read = {
        deployment: {
          createdAt: d.createdAt ?? d.created ?? 0,
          state: d.state ?? d.readyState ?? "UNKNOWN",
          url: `https://${d.url}`,
        },
        kind: "deployed",
      };
    }
  } catch (error) {
    // Unreachable reads as no deployment, retried after the TTL; only a refusal
    // needs the founder.
    if (error instanceof HttpError && error.refused) {
      read = { kind: "refused" };
    }
  }
  deployCache.set(projectId, { at: Date.now(), read, token });
  return read;
};
