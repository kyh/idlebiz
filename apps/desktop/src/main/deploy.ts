import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { ROOT_DIR } from "@/main/paths";
import { projectAccount } from "@/main/vercel";
import type { VercelBinding } from "@/shared/domain";
import { errorMessage } from "@/shared/errors";
import { DEPLOY_TIMEOUT_MS } from "@/shared/tool-specs";

/** A production deploy of one folder with the founder's token, into the project it is bound to, if any. */
export interface DeployRequest {
  cwd: string;
  token: string;
  binding: VercelBinding | null;
}

/** `output` is what the CLI printed, token and all, or why it never started: whoever shows it to an agent scrubs it. */
export type DeployResult =
  | { ok: true; url: string; output: string }
  | { ok: false; output: string };

export type Deployer = (req: DeployRequest) => Promise<DeployResult>;

/**
 * npx runs a `vercel` that the folder it starts in, or any above it, provides before
 * the real one, so it starts where no agent can write: under the save, outside every
 * writable root (the tool cache and $TMPDIR included). The product's folder is only
 * ever the CLI's argument.
 */
const LAUNCH_DIR = path.join(ROOT_DIR, ".deploy");

const deployArgs = (folder: string): string[] => [
  "--yes",
  "vercel",
  "deploy",
  folder,
  "--prod",
  "--yes",
];

/**
 * The CLI builds and runs a config written as code to read it, in a child that
 * inherits the token (and the folder's .env), and no flag turns that off.
 */
const CONFIG_AS_CODE = ["ts", "mts", "js", "mjs", "cjs"].map((ext) => `vercel.${ext}`);

// only a runaway fills it: an agent reads the output's tail
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const execFileAsync = promisify(execFile);

const ALIASED = /^\S*\s*Aliased\s+(?<url>https:\/\/\S+)/mu;

/**
 * The production domain a deploy was aliased to, from the CLI's `▲ Aliased  https://…`
 * line on stderr. The URL on stdout is the deployment's own, which Vercel's default
 * protection keeps behind a login for everyone outside the team.
 */
export const productionAlias = (output: string): string | null =>
  ALIASED.exec(output)?.groups?.url ?? null;

/** What a command that failed had printed: execFile hangs it on the error. */
const Printed = z.object({ stderr: z.string(), stdout: z.string() });

/**
 * Main's env is the founder's, with whatever credentials their shell exports, so the CLI
 * gets only what it runs on. A relative PATH entry names a folder in whichever directory
 * a program runs, and the CLI runs git in the product's.
 */
const passedThrough = () => ({
  ...Object.fromEntries(
    ["HOME", "TMPDIR", "LANG"].flatMap((key): [string, string][] => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  ),
  PATH: (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir))
    .join(path.delimiter),
});

const cliEnv = async ({ token, binding }: DeployRequest): Promise<Record<string, string>> => {
  const env = {
    ...passedThrough(),
    CI: "1",
    // the CLI reads commit metadata with `git status` in the product's folder, and a
    // repo's own config names commands git runs there (core.fsmonitor, filters)
    GIT_DIR: "/dev/null",
    VERCEL_TOKEN: token,
  };
  // the CLI deploys into a project only when told both
  return binding === null
    ? env
    : {
        ...env,
        VERCEL_ORG_ID: await projectAccount(binding, token),
        VERCEL_PROJECT_ID: binding.projectId,
      };
};

/** The Vercel CLI, run here in main so an employee's process never holds its token. */
export const deployToVercel: Deployer = async (req) => {
  // looked up by name, as the CLI does, so a folder that cannot be listed still answers
  const config = CONFIG_AS_CODE.find((name) => existsSync(path.join(req.cwd, name)));
  if (config !== undefined) {
    return {
      ok: false,
      output: `The deploy was not started: the product's folder holds ${config}, which the Vercel CLI would run with the founder's key. Move that config into vercel.json, delete ${config}, then deploy again.`,
    };
  }
  const signal = AbortSignal.timeout(DEPLOY_TIMEOUT_MS);
  try {
    await mkdir(LAUNCH_DIR, { recursive: true });
    const { stdout, stderr } = await execFileAsync("npx", deployArgs(req.cwd), {
      cwd: LAUNCH_DIR,
      encoding: "utf-8",
      env: await cliEnv(req),
      maxBuffer: MAX_OUTPUT_BYTES,
      signal,
    });
    const output = `${stderr}${stdout}`.trim();
    // off a terminal, the CLI prints the deployment's URL alone on stdout
    const url = stdout
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.startsWith("https://"));
    return url === undefined ? { ok: false, output } : { ok: true, output, url };
  } catch (error) {
    const printed = Printed.safeParse(error);
    const output = printed.success ? `${printed.data.stderr}${printed.data.stdout}`.trim() : "";
    if (signal.aborted) {
      const stopped = `Vercel had not finished after ${DEPLOY_TIMEOUT_MS / 60_000} minutes; the deploy was stopped.`;
      return { ok: false, output: `${output}\n${stopped}`.trim() };
    }
    // a CLI that never started, or a project Vercel would not place, printed nothing
    return { ok: false, output: output || errorMessage(error) };
  }
};
