import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RUNNER_IDS } from "@repo/agent-driver/runner";
import { z } from "zod";
import { PUSH_STAGING_DIR } from "@/main/git-push";
import { SECRETS_PATH } from "@/main/secrets";
import type { AgentRunner, LoadReport } from "@/shared/domain";
import { errorMessage } from "@/shared/errors";

// macOS's own: one found on PATH could be anything.
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** The founder's logins under HOME, which no run reads or writes. */
const LOGINS = [
  ".ssh",
  ".config/gh",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".config/git/credentials",
  ".aws",
  ".docker",
  ".gnupg",
  ".config/gcloud",
  ".config/stripe",
  ".wrangler",
  ".config/.wrangler",
  "Library/Preferences/.wrangler",
  ".config/netlify",
  "Library/Preferences/netlify",
  "Library/Application Support/com.vercel.cli",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/BraveSoftware",
  "Library/Cookies",
];

/** What runs as the founder later, under HOME: a run reads it but never writes it. */
const RUN_LATER = [
  "Library/LaunchAgents",
  ".config",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".gitconfig",
];

/**
 * What a run gives up besides the founder's logins: the other runner's login (every name in
 * HOME that starts with it, so ~/.claude.json goes with ~/.claude), and the Keychain unless its
 * own login is kept there, as claude's is.
 */
const RUNNER_SEALS = {
  claude: { keychain: "open", otherLogin: ".codex" },
  codex: { keychain: "sealed", otherLogin: ".claude" },
} as const satisfies Record<AgentRunner, { keychain: "open" | "sealed"; otherLogin: string }>;

/** What a rule reaches: a path and all under it (a file is only itself), or every path starting with it. */
interface Reach {
  match: "subpath" | "prefix";
  path: string;
}

/**
 * What every employee run is sealed with, on this machine. Seatbelt matches the path a symlink
 * leads to, not the link, so a path reached through one is sealed at both ends.
 */
export interface Seal {
  /** No run reads or writes these: the founder's logins, IdleBiz's own keys and where main stages a push. */
  unreadable: readonly Reach[];
  /** A run reads these but never writes them. */
  unwritable: readonly Reach[];
  /** Per runner, the other runner's login, which its runs cannot read or write either. */
  otherLogin: Record<AgentRunner, readonly Reach[]>;
  /** The founder's ssh agent, when main's env names one. */
  sshAgent: string | null;
}

// git's Keychain helper and macOS's own ssh agent sign as the founder with no file to seal.
const BASE_PROFILE = String.raw`(version 1)
(allow default)
(deny process-exec (regex #"/git-credential-osxkeychain$"))
(deny network-outbound (regex #"^/private/(tmp|var/run)/com\.apple\.launchd\.[^/]+/Listeners$"))`;

// A deny with no filter denies everything, so a rule with nothing to reach is left out.
const deny = (operations: string, filters: readonly string[]): string[] =>
  filters.length === 0 ? [] : [`(deny ${operations} ${filters.join(" ")})`];

/** Every folder above `paths` but the root. */
const foldersAbove = (paths: readonly string[]): string[] => {
  const folders = new Set<string>();
  for (const at of paths) {
    for (let dir = path.dirname(at); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      folders.add(dir);
    }
  }
  return [...folders];
};

/** `argv` as a `runner` run starts it: under the profile, with this machine's paths. */
export const sealedCommand = (
  seal: Seal,
  runner: AgentRunner,
  argv: readonly string[],
): string[] => {
  // Each path is a parameter, never quoted into the profile's source.
  const params: string[] = [];
  const param = (value: string): string => `(param "P${params.push(value) - 1}")`;
  const reach = ({ match, path: at }: Reach): string => `(${match} ${param(at)})`;
  const unreadable = [...seal.unreadable, ...seal.otherLogin[runner]];
  const sealed = [...unreadable, ...seal.unwritable].map(({ path: at }) => at);
  const profile = [
    BASE_PROFILE,
    ...deny("file-read* file-write*", unreadable.map(reach)),
    ...deny("file-write*", seal.unwritable.map(reach)),
    // Renaming a folder above a sealed path would carry it out from under its rule.
    ...deny(
      "file-write-unlink",
      foldersAbove(sealed).map((dir) => `(literal ${param(dir)})`),
    ),
    ...(RUNNER_SEALS[runner].keychain === "sealed"
      ? ['(deny process-exec (literal "/usr/bin/security"))']
      : []),
    ...(seal.sshAgent === null
      ? []
      : deny("network-outbound", [`(literal ${param(seal.sshAgent)})`])),
  ].join("\n");
  const defines = params.flatMap((value, at) => ["-D", `P${at}=${value}`]);
  return [SANDBOX_EXEC, "-p", profile, ...defines, ...argv];
};

/** How a program run under the profile ended: its exit code, or null when it never ran or was killed. */
export type SealProbe = (
  argv: readonly string[],
  env: Record<string, string>,
) => Promise<number | null>;

const PROBE_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);

const Exited = z.object({ code: z.number() });

const runProbe: SealProbe = async ([bin = SANDBOX_EXEC, ...args], env) => {
  try {
    await execFileAsync(bin, args, { env, timeout: PROBE_TIMEOUT_MS });
    return 0;
  } catch (error) {
    const exited = Exited.safeParse(error);
    return exited.success ? exited.data.code : null;
  }
};

// Exit 0 only when the canary the profile seals cannot be read; 3 when it can.
const READ_CANARY = `try { require("node:fs").readFileSync(process.argv[1]); process.exit(3); } catch (error) { process.exit(error.code === "EPERM" ? 0 : 4); }`;

const refusalFor = (code: number | null): string | null => {
  if (code === 0) {
    return null;
  }
  if (code === null) {
    return "IdleBiz could not run macOS's sandbox-exec, which every employee run starts inside, so none will start.";
  }
  if (code === 3) {
    return "IdleBiz's sandbox let a run read a file it seals, so no employee run will start.";
  }
  return `An employee run could not start inside IdleBiz's sandbox (exit ${code}), so none will.`;
};

/**
 * Why no run can be sealed, or null when every runner's can: under each one's profile, a canary
 * sealed the way secrets.json is must be unreadable, and the runtime the ACP adapters run on
 * must start. Free: nothing here asks a model.
 */
export const checkSeal = async (
  seal: Seal,
  probe: SealProbe = runProbe,
): Promise<string | null> => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "idlebiz-seal-")));
  try {
    const canary = path.join(dir, "secrets.json");
    await writeFile(canary, "canary");
    const probed: Seal = {
      ...seal,
      unreadable: [...seal.unreadable, { match: "subpath", path: canary }],
    };
    const codes = await Promise.all(
      RUNNER_IDS.map((runner) =>
        probe(sealedCommand(probed, runner, [process.execPath, "-e", READ_CANARY, canary]), {
          ELECTRON_RUN_AS_NODE: "1",
        }),
      ),
    );
    return codes.map(refusalFor).find((refusal) => refusal !== null) ?? null;
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

/** The path Seatbelt sees for `file`: the real path of the deepest part that exists, the rest after it. */
const real = async (file: string): Promise<string> => {
  try {
    return await realpath(file);
  } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(await real(parent), path.basename(file));
  }
};

/** `named`, and where it leads when a symlink on its way points somewhere else. */
const reachOf = async (named: string): Promise<Reach[]> => {
  const resolved = await real(named);
  return [named, ...(resolved === named ? [] : [resolved])].map((at): Reach => ({
    match: "subpath",
    path: at,
  }));
};

const reachesOf = async (paths: readonly string[]): Promise<Reach[]> => {
  const reaches = await Promise.all(paths.map(reachOf));
  return reaches.flat();
};

/** Every name in `home` starting with `login`, and where any of them leads. */
const loginOf = async (home: string, login: string): Promise<Reach[]> => {
  const prefix = path.join(home, login);
  const names = await readdir(home).catch(() => []);
  const reaches = await Promise.all(
    names.filter((name) => name.startsWith(login)).map((name) => reachOf(path.join(home, name))),
  );
  return [
    { match: "prefix", path: prefix },
    ...reaches.flat().filter(({ path: at }) => !at.startsWith(prefix)),
  ];
};

/** The seal of runs under `home`, resolved as it stands on disk now. */
export const sealFor = async ({
  home,
  mainOnly,
  sshAgent,
}: {
  home: string;
  /** What only main touches: its keys, where it stages a push. */
  mainOnly: readonly string[];
  sshAgent: string | null;
}): Promise<Seal> => {
  const realHome = await real(home);
  const under = (names: readonly string[]): Promise<Reach[]> =>
    reachesOf(names.map((name) => path.join(realHome, name)));
  return {
    otherLogin: {
      claude: await loginOf(realHome, RUNNER_SEALS.claude.otherLogin),
      codex: await loginOf(realHome, RUNNER_SEALS.codex.otherLogin),
    },
    sshAgent: sshAgent === null ? null : await real(sshAgent),
    unreadable: [...(await under(LOGINS)), ...(await reachesOf(mainOnly))],
    unwritable: await under(RUN_LATER),
  };
};

/** Whether employee runs start sealed, and with what; a refusal is the sentence the founder reads. */
export type SealState = { kind: "sealed"; seal: Seal } | { kind: "refused"; reason: string };

/** This machine's seal, checked before any run may use it. */
export const sealRuns = async (): Promise<SealState> => {
  const agent = process.env.SSH_AUTH_SOCK;
  try {
    const seal = await sealFor({
      home: homedir(),
      mainOnly: [SECRETS_PATH, PUSH_STAGING_DIR],
      sshAgent: agent === undefined || agent === "" ? null : agent,
    });
    const refusal = await checkSeal(seal);
    return refusal === null ? { kind: "sealed", seal } : { kind: "refused", reason: refusal };
  } catch (error) {
    const reason = `IdleBiz could not check the sandbox employee runs start inside (${errorMessage(error)}), so none will start.`;
    return { kind: "refused", reason };
  }
};

/** Boot's report with the seal's refusal beside what it left out of the save: every run, for want of the sandbox. */
export const notingSeal = (report: LoadReport, refusal: string | null): LoadReport =>
  refusal === null
    ? report
    : {
        ...report,
        skipped: [...report.skipped, { error: refusal, kind: "seal", path: SANDBOX_EXEC }],
      };
