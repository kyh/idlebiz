import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import ignore from "ignore";
import type { Ignore } from "ignore";
import { z } from "zod";
import { HttpError, fetchOk } from "@/main/lib/http";
import { VERCEL_API } from "@/main/vercel";
import type { VercelBinding } from "@/shared/domain";
import { errorMessage } from "@/shared/errors";
import { DEPLOY_TIMEOUT_MS } from "@/shared/tool-specs";

/**
 * Where a deploy lands: the project the product is bound to, or a new one named for it.
 * Main names it either way, so no file in the folder (`.vercel/project.json`, a `name`
 * in vercel.json) picks which of the founder's projects is overwritten.
 */
export type DeployTarget =
  | { kind: "bound"; binding: VercelBinding }
  | { kind: "new"; name: string };

/** A production deploy of one folder with the founder's token. */
export interface DeployRequest {
  cwd: string;
  token: string;
  target: DeployTarget;
}

/**
 * `project` is the one the deploy landed in; a failed one names it too once Vercel made
 * the deployment, since a new project exists from then on. `alias` is the production
 * domain Vercel pointed at it, if any. A reason is written for the agent, and holds
 * nothing but Vercel's own words and ours.
 */
export type DeployResult =
  | { kind: "deployed"; url: string; alias: string | null; project: VercelBinding }
  | { kind: "failed"; reason: string; project: VercelBinding | null }
  | { kind: "name-taken"; name: string };

export type Deployer = (req: DeployRequest) => Promise<DeployResult>;

/** What the Vercel CLI never uploads (@vercel/client's list), before the folder's `.vercelignore`. */
const ALWAYS_IGNORED = [
  ".hg",
  ".git",
  ".gitmodules",
  ".svn",
  ".cache",
  ".next",
  ".now",
  ".vercel",
  ".npmignore",
  ".dockerignore",
  ".gitignore",
  ".*.swp",
  ".DS_Store",
  ".wafpicke-*",
  ".lock-wscript",
  ".env.local",
  ".env.*.local",
  ".venv",
  ".yarn/cache",
  ".pnp*",
  "npm-debug.log",
  "config.gypi",
  "node_modules",
  "__pycache__",
  "venv",
  "CVS",
];

// oxlint-disable-next-line no-bitwise -- open(2) takes its flags as one bit set
const READ_IN_PLACE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** A file as Vercel stores it: a symlink's bytes are the path it holds, never what that names. */
interface Contents {
  kind: "file" | "link";
  data: Buffer;
  mode: number;
}

/**
 * What is at `at` as the CLI uploads it, or null for what it skips (a pipe, a socket).
 * The open follows no link swapped in since the lstat and waits on no pipe.
 */
const contentsOf = async (at: string): Promise<Contents | null> => {
  const stat = await lstat(at);
  if (stat.isSymbolicLink()) {
    return { data: await readlink(at, { encoding: "buffer" }), kind: "link", mode: stat.mode };
  }
  if (!stat.isFile()) {
    return null;
  }
  const handle = await open(at, READ_IN_PLACE);
  try {
    const opened = await handle.stat();
    return opened.isFile()
      ? { data: await handle.readFile(), kind: "file", mode: opened.mode }
      : null;
  } finally {
    await handle.close();
  }
};

const sha1 = (data: Buffer): string => createHash("sha1").update(data).digest("hex");

/** The rules the CLI reads: its own, then a `.vercelignore` the folder holds as a plain file. */
const ignoreRulesOf = async (root: string): Promise<Ignore> => {
  const rules = ignore().add(ALWAYS_IGNORED);
  try {
    const own = await contentsOf(path.join(root, ".vercelignore"));
    // the CLI reads `./x` as `x`
    return own?.kind === "file"
      ? rules.add(own.data.toString("utf-8").replaceAll(/(?<start>^|\n)\.\//gu, "$<start>"))
      : rules;
  } catch {
    return rules;
  }
};

/** A file of the deploy, by its path in the folder and the digest Vercel knows it by. */
interface Entry {
  file: string;
  sha: string;
  size: number;
  mode: number;
}

/** Every file the CLI would upload from `root`, read once here so nothing in it ever runs. */
const entriesOf = async (root: string): Promise<Entry[]> => {
  const rules = await ignoreRulesOf(root);
  const entries: Entry[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const item of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const file = path.posix.join(dir, item.name);
      if (item.isDirectory()) {
        if (!rules.ignores(`${file}/`)) {
          await visit(file);
        }
      } else if (!rules.ignores(file)) {
        const contents = await contentsOf(path.join(root, file));
        if (contents !== null) {
          const { data, mode } = contents;
          entries.push({ file, mode, sha: sha1(data), size: data.length });
        }
      }
    }
  };
  await visit("");
  return entries.toSorted((a, b) => (a.file < b.file ? -1 : 1));
};

/** Vercel's word on a call it turned down, and on a deploy the files it has yet to receive. */
const VercelRefusal = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string().optional(),
    missing: z.array(z.string()).optional(),
  }),
});

/** How a deployment is doing, all a poll needs, and all Vercel shows a caller who is not its owner. */
const ProgressSchema = z.object({
  alias: z.array(z.string()).optional(),
  aliasAssigned: z.union([z.boolean(), z.number()]).nullish(),
  aliasError: z.object({ message: z.string() }).nullish(),
  errorMessage: z.string().nullish(),
  readyState: z.string(),
  readySubstate: z.string().optional(),
});
const DeploymentSchema = ProgressSchema.extend({
  id: z.string(),
  // the account the deployment landed in: a team's id, or the founder's own user id
  ownerId: z.string().optional(),
  projectId: z.string(),
  url: z.string(),
});
type Deployment = z.infer<typeof DeploymentSchema>;

type VercelCall = (
  route: string,
  init?: { method: "POST"; headers: Record<string, string>; body: string | Buffer },
  query?: Record<string, string>,
) => Promise<Response>;

/** Calls to Vercel's API as the founder, in the target's team, all ending by `deadline`. */
const callerFor =
  (token: string, teamId: string | null, deadline: AbortSignal): VercelCall =>
  (route, init, query = {}) => {
    const params = new URLSearchParams(teamId === null ? query : { ...query, teamId });
    return fetchOk(`${VERCEL_API}${route}${params.size > 0 ? `?${params.toString()}` : ""}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${token}` },
      signal: deadline,
    });
  };

const hasProjectNamed = async (call: VercelCall, name: string): Promise<boolean> => {
  try {
    await call(`/v9/projects/${encodeURIComponent(name)}`);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return false;
    }
    throw error;
  }
};

/** Upload a file Vercel lacks, refusing one that changed since it was read. */
const upload = async (call: VercelCall, root: string, entry: Entry): Promise<void> => {
  const now = await contentsOf(path.join(root, entry.file));
  if (now === null || sha1(now.data) !== entry.sha) {
    throw new Error(
      `${entry.file} changed while it was being deployed: let the team finish writing, then deploy again.`,
    );
  }
  await call("/v2/files", {
    body: now.data,
    headers: { "Content-Type": "application/octet-stream", "x-vercel-digest": entry.sha },
    method: "POST",
  });
};

const UPLOADS_AT_ONCE = 8;

/** Run `work` on each item, `width` at a time. */
const eachAtMost = async <T>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) {
        await work(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
};

/**
 * Create the production deployment. Vercel names the files it has yet to receive, which
 * are uploaded before asking again, as the CLI does.
 */
const createDeployment = async (
  call: VercelCall,
  root: string,
  entries: readonly Entry[],
  target: DeployTarget,
): Promise<Deployment> => {
  const project =
    target.kind === "bound"
      ? { name: target.binding.projectName, project: target.binding.projectId }
      : { name: target.name };
  const create = async (): Promise<Deployment> => {
    const res = await call(
      "/v13/deployments",
      {
        body: JSON.stringify({
          ...project,
          files: entries.map(({ file, mode, sha, size }) => ({ file, mode, sha, size })),
          target: "production",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
      // a new project takes the framework Vercel detects, as `vercel deploy --yes` does
      { skipAutoDetectionConfirmation: "1" },
    );
    return DeploymentSchema.parse(await res.json());
  };
  try {
    return await create();
  } catch (error) {
    const said = error instanceof HttpError ? VercelRefusal.safeParse(error.answer) : null;
    if (!said?.success || said.data.error.code !== "missing_files") {
      throw error;
    }
    const bySha = new Map(entries.map((entry) => [entry.sha, entry]));
    const missing = (said.data.error.missing ?? []).flatMap((sha) => bySha.get(sha) ?? []);
    await eachAtMost(missing, UPLOADS_AT_ONCE, (entry) => upload(call, root, entry));
  }
  return await create();
};

/** The CLI's pace: quick while a build is young, slower as it runs long. */
const pollDelayMs = (elapsed: number): number => {
  if (elapsed <= 15_000) {
    return 1000;
  }
  return elapsed <= 60_000 ? 5000 : 15_000;
};

/** Why a finished deployment is not live, or null while it is live or still going. */
const failureOf = (d: Deployment): string | null => {
  if (d.readyState === "ERROR") {
    const said = d.errorMessage ? `: ${d.errorMessage}` : "";
    return `Vercel's build failed${said}. Run the build in the product's folder to see why, fix it, then deploy again.`;
  }
  if (d.readyState === "CANCELED") {
    return "Vercel canceled the deployment before it went live.";
  }
  if (d.aliasError) {
    return `Vercel built it but could not point production at it: ${d.aliasError.message}`;
  }
  return null;
};

/**
 * Live once built and given the production domain, or built where no domain follows on its
 * own: a project that stages production deploys, or rolls them out.
 */
const isLive = (d: Deployment): boolean =>
  d.readyState === "READY" &&
  (Boolean(d.aliasAssigned) || d.readySubstate === "STAGED" || d.readySubstate === "ROLLING");

const projectOf = (target: DeployTarget, d: Deployment): VercelBinding =>
  target.kind === "bound"
    ? target.binding
    : {
        projectId: d.projectId,
        projectName: target.name,
        // a new project lands in the token's default scope; bind that scope, not whichever is default later
        teamId: d.ownerId?.startsWith("team_") ? d.ownerId : null,
      };

const deployed = (target: DeployTarget, d: Deployment): DeployResult => ({
  alias: d.aliasAssigned && d.alias?.[0] !== undefined ? `https://${d.alias[0]}` : null,
  kind: "deployed",
  project: projectOf(target, d),
  url: `https://${d.url}`,
});

/** A failed call in Vercel's words, which never repeat the token it was sent with. */
const refusalReason = (error: HttpError): string => {
  const said = VercelRefusal.safeParse(error.answer);
  const why = said.success ? said.data.error.message : undefined;
  return `Vercel turned the deploy down (${error.status})${why === undefined ? "" : `: ${why}`}`;
};

/**
 * A production deploy through Vercel's API, run here in main so an employee's process
 * never holds the token. Main reads the folder and Vercel builds it on its own machines:
 * nothing in the folder runs here, where the token is, whatever the files say.
 */
export const deployToVercel: Deployer = async ({ cwd, target, token }) => {
  const deadline = AbortSignal.timeout(DEPLOY_TIMEOUT_MS);
  const call = callerFor(token, target.kind === "bound" ? target.binding.teamId : null, deadline);
  let latest: Deployment | null = null;
  try {
    const entries = await entriesOf(cwd);
    // a new project is made by the deploy, and one already named so would take it instead
    if (target.kind === "new" && (await hasProjectNamed(call, target.name))) {
      return { kind: "name-taken", name: target.name };
    }
    latest = await createDeployment(call, cwd, entries, target);
    const started = Date.now();
    while (!isLive(latest) && failureOf(latest) === null) {
      await sleep(pollDelayMs(Date.now() - started), undefined, { signal: deadline });
      const res = await call(`/v13/deployments/${encodeURIComponent(latest.id)}`);
      latest = { ...latest, ...ProgressSchema.parse(await res.json()) };
    }
    const failed = failureOf(latest);
    return failed === null
      ? deployed(target, latest)
      : { kind: "failed", project: projectOf(target, latest), reason: failed };
  } catch (error) {
    const project = latest === null ? null : projectOf(target, latest);
    if (deadline.aborted) {
      // built, but the production domain had not followed yet
      if (latest?.readyState === "READY") {
        return deployed(target, latest);
      }
      const reason = `Vercel had not finished after ${DEPLOY_TIMEOUT_MS / 60_000} minutes. IdleBiz stopped waiting, but the deploy may still go live: check the product's URL before deploying again.`;
      return { kind: "failed", project, reason };
    }
    const reason = error instanceof HttpError ? refusalReason(error) : errorMessage(error);
    return { kind: "failed", project, reason };
  }
};
