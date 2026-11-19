import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import ignore from "ignore";
import { z } from "zod";
import { HttpError } from "./lib/http";
import { vercelCall, vercelRefusalOf } from "./vercel-api";
import type { VercelCallOptions, VercelScope } from "./vercel-api";
import { MIN_SECRET_LENGTH } from "./vault/vault";
import type { HeldKey } from "./vault/vault";
import type { KeptEnvValue } from "./vercel-env";
import type { VercelBinding } from "@repo/domain/domain";
import { errorMessage } from "@repo/domain/errors";
import { DEPLOY_TIMEOUT_MS } from "./tool-specs";

/**
 * Where a deploy lands: the project the product is bound to, or a new one named for it.
 * Main names it either way, so no file in the folder (`.vercel/project.json`, a `name`
 * in vercel.json) picks which of the founder's projects is overwritten.
 */
export type DeployTarget =
  | { kind: "bound"; binding: VercelBinding }
  | { kind: "new"; name: string };

/** A value no deploy may ship: one set_env set on a product, or a key IdleBiz itself holds. */
export type Unshippable = KeptEnvValue | HeldKey;

/** A production deploy of one folder with the founder's token, refused while a file holds a value in `unshippable`. */
export interface DeployRequest {
  cwd: string;
  token: string;
  target: DeployTarget;
  unshippable: readonly Unshippable[];
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

interface Contents {
  kind: "file" | "link";
  data: Buffer;
  mode: number;
}

const contentsOf = async (at: string) => {
  const stat = await lstat(at);

  if (stat.isSymbolicLink()) {
    return {
      data: await readlink(at, { encoding: "buffer" }),
      kind: "link",
      mode: stat.mode,
    } satisfies Contents | null;
  }

  if (!stat.isFile()) {
    return null;
  }

  const handle = await open(at, READ_IN_PLACE);

  try {
    const opened = await handle.stat();

    return (
      opened.isFile() ? { data: await handle.readFile(), kind: "file", mode: opened.mode } : null
    ) satisfies Contents | null;
  } finally {
    await handle.close();
  }
};

const sha1 = (data: Buffer) => createHash("sha1").update(data).digest("hex");

const ignoreRulesOf = async (root: string) => {
  const rules = ignore().add(ALWAYS_IGNORED);

  try {
    const own = await contentsOf(path.join(root, ".vercelignore"));

    return own?.kind === "file"
      ? rules.add(own.data.toString("utf-8").replaceAll(/(?<start>^|\n)\.\//gu, "$<start>"))
      : rules;
  } catch {
    return rules;
  }
};

interface Entry {
  file: string;
  sha: string;
  size: number;
  mode: number;
}

interface Leak {
  kind: "leak";
  file: string;
  held: Unshippable;
}

const entriesOf = async (root: string, unshippable: readonly Unshippable[]) => {
  const rules = await ignoreRulesOf(root);
  const guarded = unshippable.filter((held) => held.value.length >= MIN_SECRET_LENGTH);
  const entries: Entry[] = [];

  const visit: (dir: string) => Promise<Leak | null> = async (dir) => {
    for (const item of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const file = path.posix.join(dir, item.name);

      if (item.isDirectory()) {
        const leak = rules.ignores(`${file}/`) ? null : await visit(file);

        if (leak !== null) {
          return leak;
        }
      } else if (!rules.ignores(file)) {
        const contents = await contentsOf(path.join(root, file));

        if (contents !== null) {
          const { data, mode } = contents;
          const held = guarded.find(({ value }) => data.includes(value));

          if (held !== undefined) {
            return { file, held, kind: "leak" } satisfies Leak | null;
          }

          entries.push({ file, mode, sha: sha1(data), size: data.length });
        }
      }
    }

    return null;
  };

  return ((await visit("")) ?? {
    entries: entries.toSorted((a, b) => (a.file < b.file ? -1 : 1)),
    kind: "entries",
  }) satisfies { kind: "entries"; entries: Entry[] } | Leak;
};

const leakReason = ({ file, held }: Leak) =>
  held.kind === "env"
    ? `Nothing was deployed: ${file} holds the value set_env set as ${held.name} on ${held.product}, and a deploy would publish it. Take it out of the folder, read it from process.env.${held.name} instead, then deploy again.`
    : `Nothing was deployed: ${file} holds IdleBiz's own ${held.name}, which never leaves IdleBiz and would be published. Take it out of the folder, then deploy again: what needs that key is a tool IdleBiz runs itself, or a key of the product's own, set with set_env.`;

/**
 * Why the folder may not ship, read before the founder is asked to sign off on a deploy
 * that would only be refused; null when it may, or when it cannot be read, which the
 * deploy's own read then reports.
 */
export const unshippableIn = async (cwd: string, unshippable: readonly Unshippable[]) => {
  try {
    const read = await entriesOf(cwd, unshippable);

    return read.kind === "leak" ? leakReason(read) : null;
  } catch {
    return null;
  }
};

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
  ownerId: z.string().optional(),
  projectId: z.string(),
  url: z.string(),
});

type Deployment = z.infer<typeof DeploymentSchema>;

type VercelCall = (
  route: string,
  init?: VercelCallOptions["init"],
  query?: VercelCallOptions["query"],
) => Promise<Response>;

const callerFor = (scope: VercelScope, deadline: AbortSignal) => {
  const call: VercelCall = (route, init, query) =>
    vercelCall(route, scope, { init, query, signal: deadline });

  return call;
};

const hasProjectNamed = async (call: VercelCall, name: string) => {
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

const upload = async (call: VercelCall, root: string, entry: Entry) => {
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

const eachAtMost = async <T>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<void>,
) => {
  let next = 0;

  const worker = async () => {
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

const createDeployment = async (
  call: VercelCall,
  root: string,
  entries: readonly Entry[],
  target: DeployTarget,
) => {
  const project =
    target.kind === "bound"
      ? { name: target.binding.projectName, project: target.binding.projectId }
      : { name: target.name };

  const create = async () => {
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
      { skipAutoDetectionConfirmation: "1" },
    );

    return DeploymentSchema.parse(await res.json());
  };

  try {
    return await create();
  } catch (error) {
    const said = error instanceof HttpError ? vercelRefusalOf(error) : null;

    if (said?.code !== "missing_files") {
      throw error;
    }

    const bySha = new Map(entries.map((entry) => [entry.sha, entry]));
    const missing = (said.missing ?? []).flatMap((sha) => bySha.get(sha) ?? []);
    await eachAtMost(missing, UPLOADS_AT_ONCE, (entry) => upload(call, root, entry));
  }

  return await create();
};

const pollDelayMs = (elapsed: number) => {
  if (elapsed <= 15_000) {
    return 1000;
  }

  return elapsed <= 60_000 ? 5000 : 15_000;
};

const failureOf = (d: Deployment) => {
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

const isLive = (d: Deployment) =>
  d.readyState === "READY" &&
  (Boolean(d.aliasAssigned) || d.readySubstate === "STAGED" || d.readySubstate === "ROLLING");

const projectOf = (target: DeployTarget, d: Deployment) =>
  (target.kind === "bound"
    ? target.binding
    : {
        projectId: d.projectId,
        projectName: target.name,
        teamId: d.ownerId?.startsWith("team_") ? d.ownerId : null,
      }) satisfies VercelBinding;

const deployed = (target: DeployTarget, d: Deployment) =>
  ({
    alias: d.aliasAssigned && d.alias?.[0] !== undefined ? `https://${d.alias[0]}` : null,
    kind: "deployed",
    project: projectOf(target, d),
    url: `https://${d.url}`,
  }) satisfies DeployResult;

const refusalReason = (error: HttpError) => {
  const why = vercelRefusalOf(error)?.message;

  return `Vercel turned the deploy down (${error.status})${why === undefined ? "" : `: ${why}`}`;
};

/**
 * A production deploy through Vercel's API, run here in main so an employee's process
 * never holds the token. Main reads the folder and Vercel builds it on its own machines:
 * nothing in the folder runs here, where the token is, whatever the files say.
 */
export const deployToVercel: Deployer = async ({ cwd, target, token, unshippable }) => {
  const deadline = AbortSignal.timeout(DEPLOY_TIMEOUT_MS);

  const call = callerFor(
    { teamId: target.kind === "bound" ? target.binding.teamId : null, token },
    deadline,
  );

  let latest: Deployment | null = null;

  try {
    const read = await entriesOf(cwd, unshippable);

    if (read.kind === "leak") {
      return { kind: "failed", project: null, reason: leakReason(read) };
    }

    const { entries } = read;

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
