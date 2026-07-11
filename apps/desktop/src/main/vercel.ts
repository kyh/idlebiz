import { z } from "zod";

// ---------------------------------------------------------------------------
// Vercel REST API helpers. The founder connects with a personal access token
// (no OAuth app needed): validate → pick a project → the token lands in
// secrets.json as VERCEL_TOKEN, which both the metrics pulse (users =
// Web Analytics visitors) and the agents' shells (real deploys via the
// vercel CLI) inherit.
// ---------------------------------------------------------------------------

const API = "https://api.vercel.com";

function envToken(): string | null {
  return process.env["VERCEL_TOKEN"] ?? null;
}

async function apiGet(
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}${path}${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`vercel ${path} -> ${res.status}`);
  return res.json();
}

// ---- token validation --------------------------------------------------------

const UserSchema = z.object({
  user: z.object({ username: z.string().optional(), name: z.string().nullish() }),
});

/** Cheap token check; returns the account name it belongs to. */
export async function validateToken(token: string): Promise<{ ok: boolean; account?: string }> {
  try {
    const parsed = UserSchema.safeParse(await apiGet("/v2/user", token));
    if (!parsed.success) return { ok: true };
    return { ok: true, account: parsed.data.user.name ?? parsed.data.user.username };
  } catch {
    return { ok: false };
  }
}

// ---- projects ----------------------------------------------------------------

export interface VercelProject {
  id: string;
  name: string;
  teamId?: string;
}

const ProjectsSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});
const TeamsSchema = z.object({
  teams: z.array(z.object({ id: z.string(), name: z.string().nullish() })).default([]),
});

/** Projects across the personal account and every team the token can see. */
export async function listProjects(token: string): Promise<VercelProject[]> {
  const out: VercelProject[] = [];
  const personal = ProjectsSchema.safeParse(await apiGet("/v9/projects", token, { limit: "100" }));
  if (personal.success) {
    out.push(...personal.data.projects.map((p) => ({ id: p.id, name: p.name })));
  }
  try {
    const teams = TeamsSchema.safeParse(await apiGet("/v2/teams", token, { limit: "20" }));
    if (teams.success) {
      for (const team of teams.data.teams) {
        const projs = ProjectsSchema.safeParse(
          await apiGet("/v9/projects", token, { limit: "100", teamId: team.id }),
        );
        if (projs.success) {
          out.push(
            ...projs.data.projects.map((p) => ({ id: p.id, name: p.name, teamId: team.id })),
          );
        }
      }
    }
  } catch {
    /* personal-only token */
  }
  return out;
}

// ---- web analytics (users) ---------------------------------------------------

const VisitsCountSchema = z.object({
  data: z.object({ visitors: z.number().optional(), pageviews: z.number().optional() }),
});

/**
 * Unique visitors for the project — the HUD's "users" number. Prefers a
 * 30-day window; falls back to the unscoped production total if the dated
 * query is rejected.
 */
export async function webAnalyticsVisitors(
  projectId: string,
  teamId?: string,
): Promise<number | null> {
  const token = envToken();
  if (!token) return null;
  const base: Record<string, string> = { projectId };
  if (teamId) base.teamId = teamId;
  const since = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString().slice(0, 10);
  for (const params of [{ ...base, since }, base]) {
    try {
      const parsed = VisitsCountSchema.safeParse(
        await apiGet("/v1/query/web-analytics/visits/count", token, params),
      );
      if (parsed.success && typeof parsed.data.data.visitors === "number") {
        return parsed.data.data.visitors;
      }
    } catch {
      /* try the next parameter shape */
    }
  }
  return null;
}

// ---- deployments (product state) ---------------------------------------------

export interface VercelDeployment {
  url: string;
  state: string;
  createdAt: number;
}

const DeploymentsSchema = z.object({
  deployments: z
    .array(
      z.object({
        url: z.string().optional(),
        state: z.string().optional(),
        readyState: z.string().optional(),
        createdAt: z.number().optional(),
        created: z.number().optional(),
      }),
    )
    .default([]),
});

/** The latest production deployment — the product panel's "LIVE" state. */
export async function latestDeployment(
  projectId: string,
  teamId?: string,
): Promise<VercelDeployment | null> {
  const token = envToken();
  if (!token) return null;
  const params: Record<string, string> = { projectId, limit: "1", target: "production" };
  if (teamId) params.teamId = teamId;
  try {
    const parsed = DeploymentsSchema.safeParse(await apiGet("/v6/deployments", token, params));
    if (!parsed.success) return null;
    const d = parsed.data.deployments[0];
    if (!d || !d.url) return null;
    return {
      url: `https://${d.url}`,
      state: d.state ?? d.readyState ?? "UNKNOWN",
      createdAt: d.createdAt ?? d.created ?? 0,
    };
  } catch {
    return null;
  }
}
