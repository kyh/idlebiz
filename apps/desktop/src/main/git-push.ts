import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { ROOT_DIR } from "@/main/paths";
import { errorMessage } from "@/shared/errors";
import { RefusalError } from "@/shared/refusal";

// An employee writes the workspace's .git/config and hooks (core.sshCommand, credential.helper,
// url.*.insteadOf, core.hooksPath…), and any git command run in that repository obeys them. So
// main runs none there: it reads the remote's URL from the file, fetches the branch through
// upload-pack (git's server side, built to serve an untrusted repository) into a repository of
// its own, and pushes from that one, with the founder's own credentials.

// macOS's own, which SIP keeps whatever the seal misses.
const GIT = "/usr/bin/git";

// git looks up ssh and any helper named without a path on PATH, and of its folders only these
// are kept by SIP rather than by the seal. Its own helpers it finds first anyway.
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

// Serving a partial clone, upload-pack fetched what it lacked, obeying that repository's config
// for its promisor remote, until these releases: 2.45.1, and 2.39.4, 2.40.2… backported. No
// flag or env turns that off in a git before them.
const LAZY_FETCH_REFUSED_FROM = new Map([
  [39, 4],
  [40, 2],
  [41, 1],
  [42, 2],
  [43, 4],
  [44, 1],
  [45, 1],
]);

/** Whether the git that printed `version` refuses to lazy-fetch while it serves a repository. */
export const refusesLazyFetch = (version: string): boolean => {
  const found = /^git version (?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(version)?.groups;
  if (found === undefined) {
    return false;
  }
  const [major, minor, patch] = [Number(found.major), Number(found.minor), Number(found.patch)];
  if (major !== 2) {
    return major > 2;
  }
  const first = LAZY_FETCH_REFUSED_FROM.get(minor);
  return minor > 45 || (first !== undefined && patch >= first);
};

/**
 * Where main stages each push. The seal keeps runs out of it: a staging repository in a folder a
 * run can write is one whose config a run can rewrite mid-push.
 */
export const PUSH_STAGING_DIR = path.join(ROOT_DIR, ".push");

const GIT_TIMEOUT_MS = 2 * 60_000;

/** How git reaches a remote: a push goes out over https or ssh; tests push to a bare repository on disk. */
type Transport = "https" | "ssh" | "file";

interface PushRequest {
  /** The product's workspace, whose repository the employee writes. */
  repo: string;
  remote: string;
  /** null for the branch the workspace has checked out. */
  branch: string | null;
}

/** What a push sends where: one commit, exactly, to the URL its remote names. */
export interface PushTarget {
  branch: string;
  sha: string;
  url: string;
}

/** `said` is git's own summary, either way, less any login in a URL. */
interface PushResult {
  kind: "pushed" | "rejected";
  target: PushTarget;
  said: string;
}

/** Push `req` once `signOff` lets its target go; `signOff` throws to hold it. */
export type Pusher = (
  req: PushRequest,
  signOff: (target: PushTarget) => void,
) => Promise<PushResult>;

const execFileAsync = promisify(execFile);

type Ran =
  | { ok: true; stdout: string; said: string }
  | { ok: false; code: number | null; said: string };

const Failed = z.object({
  code: z.number().nullish(),
  killed: z.boolean().optional(),
  stderr: z.string().optional(),
  stdout: z.string().optional(),
});

const HTTP_LOGIN = /(?<scheme>https?:\/\/)[^\s/?#@]+@/giu;
const PASSWORD = /(?<scheme>[a-z][\d+.a-z-]*:\/\/)[^\s/?#@:]*:[^\s/?#@]*@/giu;

/** `text` with every login an https URL carries, and every password any URL does, blanked out. */
export const redacted = (text: string): string =>
  text.replaceAll(HTTP_LOGIN, "$<scheme>***@").replaceAll(PASSWORD, "$<scheme>***@");

const git = async (args: readonly string[], env: NodeJS.ProcessEnv): Promise<Ran> => {
  try {
    const { stdout, stderr } = await execFileAsync(GIT, args, { env, timeout: GIT_TIMEOUT_MS });
    return { ok: true, said: redacted(`${stderr}${stdout}`.trim()), stdout };
  } catch (error) {
    const failed = Failed.safeParse(error);
    if (!failed.success) {
      return { code: null, ok: false, said: errorMessage(error) };
    }
    const { code, killed, stderr = "", stdout = "" } = failed.data;
    const words = `${stderr}${stdout}`.trim();
    const said = killed
      ? `git did not finish within ${GIT_TIMEOUT_MS / 60_000} minutes. ${words}`
      : words || errorMessage(error);
    return {
      code: code ?? null,
      ok: false,
      said: redacted(said.trim()),
    };
  }
};

/** git in `staging` reading no config but its own: nothing the founder or a run set applies. */
const isolatedIn = (staging: string): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_DIR: staging,
  // what upload-pack sets itself in a git with the fix, unless the env already says otherwise
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  PATH: SYSTEM_PATH,
});

/** git in `staging` with the founder's own config on top: their credential helpers, their ssh. */
const foundersIn = (staging: string): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_DIR: staging,
  GIT_TERMINAL_PROMPT: "0",
  PATH: SYSTEM_PATH,
});

// The workspace is reached as a path, and nothing else is reached at all.
const LOCAL_ONLY = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.file.allow=always",
];

// scheme://[login@]host[:port][/path]; a login or host starting with "-" would reach ssh as an option
const URL_FORM =
  /^(?<scheme>[a-z]+):\/\/(?:(?<login>\w[^/@]*)@)?(?<host>[\dA-Za-z](?:[\w.-]*[\dA-Za-z])?)?(?::\d+)?(?:\/.*)?$/u;
// [login@]host:path, which git reads as ssh; `::` names a remote helper (`ext::…`), `://` a URL
const SCP_FORM = /^(?:\w[\w.-]*@)?[\dA-Za-z](?:[\w.-]*[\dA-Za-z])?:(?!:|\/\/).+$/u;
// what the founder reads on the approval card is what git is handed: no space, nothing unseen
const PRINTABLE = /^[\u0021-\u007E]+$/u;
const PLAIN = /^[^\p{Cc}\p{Cf}\p{Z}]+$/u;

const UNREACHED = "which the push tool does not reach";

/** How git would reach `url`, or why the push will not go there. */
const transportOf = (
  url: string,
): { kind: "ok"; transport: Transport } | { kind: "no"; why: string } => {
  const scheme = URL_FORM.exec(url)?.groups;
  if (PRINTABLE.test(url) && scheme !== undefined) {
    if (scheme.login !== undefined && (scheme.scheme === "https" || scheme.login.includes(":"))) {
      return { kind: "no", why: "a URL with a login in it; the push signs in as the founder" };
    }
    if (scheme.scheme === "https" || scheme.scheme === "ssh") {
      return scheme.host === undefined
        ? { kind: "no", why: "a URL naming no host" }
        : { kind: "ok", transport: scheme.scheme };
    }
    if (scheme.scheme === "file") {
      return { kind: "ok", transport: "file" };
    }
  }
  if (PRINTABLE.test(url) && SCP_FORM.test(url)) {
    return { kind: "ok", transport: "ssh" };
  }
  return { kind: "no", why: UNREACHED };
};

/** The URL `remote` pushes to, as the workspace's config names it: read, so no rewrite or helper there applies. */
const pushUrlOf = async (
  repo: string,
  remote: string,
  transports: readonly Transport[],
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  const config = path.join(repo, ".git", "config");
  for (const key of ["pushurl", "url"]) {
    const read = await git(
      ["config", "--file", config, "--get-all", `remote.${remote}.${key}`],
      env,
    );
    if (!read.ok && read.code !== 1) {
      throw new RefusalError(`git could not read the workspace's git config: ${read.said}`);
    }
    const [url, ...more] = read.ok ? read.stdout.split("\n").filter((line) => line !== "") : [];
    if (url === undefined) {
      continue;
    }
    if (more.length > 0) {
      throw new RefusalError(
        `Remote "${remote}" names more than one URL to push to: keep one, since the founder signs for exactly where a push goes.`,
      );
    }
    const reached = transportOf(url);
    if (reached.kind === "no" || !transports.includes(reached.transport)) {
      const why = reached.kind === "no" ? reached.why : UNREACHED;
      throw new RefusalError(
        `Remote "${remote}" pushes to ${JSON.stringify(redacted(url))}, ${why}: the push tool takes https://host/path with no login in it, ssh://host/path or user@host:path.`,
      );
    }
    return url;
  }
  throw new RefusalError(
    `The workspace's git repository has no remote "${remote}": add it with \`git remote add ${remote} <url>\`, then push again.`,
  );
};

// Only the file as it stands: a run can rewrite it after this read or hide the key behind an
// include, so what keeps upload-pack from fetching is refusesLazyFetch. This is for a partial
// clone made in earnest, whose push would fail for want of objects.
const PARTIAL_CLONE_KEYS = String.raw`^(extensions\.partialclone|remote\..*\.promisor)$`;

/** Refuses a workspace whose git config makes it a partial clone. */
const refusePartialClone = async (repo: string, env: NodeJS.ProcessEnv): Promise<void> => {
  const read = await git(
    [
      "config",
      "--file",
      path.join(repo, ".git", "config"),
      "--name-only",
      "--get-regexp",
      PARTIAL_CLONE_KEYS,
    ],
    env,
  );
  if (!read.ok && read.code !== 1) {
    throw new RefusalError(`git could not read the workspace's git config: ${read.said}`);
  }
  if (read.ok) {
    const keys = read.stdout.split("\n").filter((line) => line !== "");
    throw new RefusalError(
      `The workspace's repository is a partial clone (${keys.join(", ")}), lacking objects a push sends: clone it again without --filter, then push.`,
    );
  }
};

/** The branch the workspace has checked out, as upload-pack reports it. */
const checkedOut = async (repo: string, env: NodeJS.ProcessEnv): Promise<string> => {
  const listed = await git([...LOCAL_ONLY, "ls-remote", "--symref", repo, "HEAD"], env);
  if (!listed.ok) {
    throw new RefusalError(`git could not read the workspace's repository: ${listed.said}`);
  }
  const branch = /^ref: refs\/heads\/(?<branch>\S+)\tHEAD$/mu.exec(listed.stdout)?.groups?.branch;
  if (branch === undefined) {
    throw new RefusalError(
      'The workspace has no branch checked out with a commit on it: commit on a branch, or name one with "branch":"<name>".',
    );
  }
  return branch;
};

/** A pusher that reaches remotes over `transports` only. */
export const pusherOver =
  (transports: readonly Transport[]): Pusher =>
  async ({ repo, remote, branch }, signOff) => {
    await mkdir(PUSH_STAGING_DIR, { recursive: true });
    const staging = await mkdtemp(path.join(PUSH_STAGING_DIR, "repo-"));
    try {
      const isolated = isolatedIn(staging);
      const version = await git(["--version"], isolated);
      if (!version.ok) {
        throw new Error(`git did not run: ${version.said}`);
      }
      if (!refusesLazyFetch(version.stdout)) {
        throw new RefusalError(
          `Nothing was pushed: ${GIT} is ${version.said}, which can run what a workspace's git config names while main reads it; a push needs 2.39.4, 2.45.1 or later. Ask the boss to update Xcode or its Command Line Tools.`,
        );
      }
      const made = await git(["init", "--quiet", "--bare", "--template="], isolated);
      if (!made.ok) {
        throw new Error(`git init failed: ${made.said}`);
      }
      const url = await pushUrlOf(repo, remote, transports, isolated);
      await refusePartialClone(repo, isolated);
      const name = branch ?? (await checkedOut(repo, isolated));
      const ref = `refs/heads/${name}`;
      const format = await git(["check-ref-format", ref], isolated);
      if (!PLAIN.test(name) || !format.ok) {
        throw new RefusalError(`${JSON.stringify(name)} is not a branch name git takes.`);
      }
      const fetched = await git(
        [
          ...LOCAL_ONLY,
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--quiet",
          repo,
          `+${ref}:${ref}`,
        ],
        isolated,
      );
      if (!fetched.ok) {
        throw new RefusalError(`git could not read ${name} from the workspace: ${fetched.said}`);
      }
      const commit = await git(["rev-parse", "--verify", `${ref}^{commit}`], isolated);
      if (!commit.ok) {
        throw new Error(`git could not name the commit it fetched: ${commit.said}`);
      }
      const target: PushTarget = { branch: name, sha: commit.stdout.trim(), url };
      signOff(target);
      const pushed = await git(
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "protocol.allow=never",
          ...transports.flatMap((transport) => ["-c", `protocol.${transport}.allow=always`]),
          "push",
          "--recurse-submodules=no",
          url,
          `${ref}:${ref}`,
        ],
        foundersIn(staging),
      );
      return { kind: pushed.ok ? "pushed" : "rejected", said: pushed.said, target };
    } finally {
      await rm(staging, { force: true, recursive: true });
    }
  };

/** Pushes the way the app does: over https or ssh, with the founder's credentials. */
export const gitPush: Pusher = pusherOver(["https", "ssh"]);
