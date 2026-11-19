import { runnerBin } from "@repo/agent-driver/detect";
import { RUNNERS } from "@repo/agent-driver/registry";
import type { RunnerAdapter, SessionSetup } from "@repo/agent-driver/registry";
import type { AcpAgent } from "@repo/agent-driver/acp-session";
import type { ToolAsk } from "@repo/agent-driver/tool-ask";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { parseJson } from "@repo/domain/json";
import type { RunnerId } from "@repo/domain/runners";
import { SYSTEM_PATH, namedWith, proxiesOf, unsandboxedEnv } from "../lib/founder-env";
import { teamNotesPrompt } from "../prompts/team-notes";
import { RefusalError } from "../refusal";
import { DEPLOY_TIMEOUT_MS } from "../tool-specs";
import { claudeUserSettings } from "./claude-user-settings";
import { runEnv } from "./run-env";
import { runTmpdir } from "./run-workspace";
import { browserSocketDir, namespaceUnder } from "@repo/sandbox/machine";
import { sandboxedCommand } from "@repo/sandbox/profile";
import type { Sandbox } from "@repo/sandbox/profile";
import { TEAM_NOTES_MAX_BYTES, readTeamNotes } from "./team-notes";

const fromPackage = createRequire(import.meta.url);

/** What of main's env a runner's CLI gets, for a run or a probe of its login alike. */
export const runnerEnv = (runner: RunnerId) => runEnv(process.env, RUNNERS[runner].providerEnv);

/**
 * What of main's env a runner's CLI gets to sign in: the account's names, main's PATH and the
 * founder's proxies, and the runner's own settings, never the rest of main's, which is launchd's in
 * the app. Its sandbox lets it open the browser and lacks the denies a run's has, so no variable a CLI
 * reads to run something on the way there (BROWSER) reaches it.
 */
export const signInEnv = (runner: RunnerId) => ({
  ...unsandboxedEnv(process.env, {
    PATH: process.env.PATH ?? SYSTEM_PATH,
    ...proxiesOf(process.env),
  }),
  ...namedWith(process.env, RUNNERS[runner].providerEnv),
});

const browserEnv = (sandbox: Sandbox, runner: RunnerId) => ({
  AGENT_BROWSER_ARGS: "--no-sandbox",
  AGENT_BROWSER_NAMESPACE: namespaceUnder(sandbox, runner),
  AGENT_BROWSER_SCREENSHOT_DIR: path.join(runTmpdir(), "screenshots"),
  AGENT_BROWSER_SOCKET_DIR: browserSocketDir(),
});

/** The folder the daemons of `runner`'s runs under `sandbox` listen in, which a run cannot make: only write inside it. */
export const makeBrowserNamespace = (sandbox: Sandbox, runner: RunnerId) => {
  mkdirSync(sandbox.namespaces[runner].path, { recursive: true });
};

/**
 * `runner`'s agent under `sandbox`, for a task's session or a one-shot's alike. `setup` is where
 * IdleBiz's skills are, and how the founder's claude signs in and which model it picks. `more`
 * joins the adapter's env over main's: codex's session config, or claude's user-settings env.
 */
export const acpAgentFor = (
  runner: RunnerId,
  sandbox: Sandbox,
  setup: SessionSetup,
  more: Record<string, string> = {},
) => {
  const adapter: RunnerAdapter = RUNNERS[runner];
  const session = adapter.session(setup);

  const env: AcpAgent["env"] = {
    ...runnerEnv(runner),
    ...more,
    ...browserEnv(sandbox, runner),
  };

  env[adapter.binEnvVar] = runnerBin(runner);

  if (runner === "claude") {
    env.BASH_DEFAULT_TIMEOUT_MS = String(DEPLOY_TIMEOUT_MS + 60_000);
  }

  return {
    command: sandboxedCommand(sandbox, runner, [
      process.execPath,
      fromPackage.resolve(adapter.acpEntry),
    ]),
    env,
    readDirs: session.readDirs,
    sessionMeta: session.meta,
    sessionMode: adapter.sessionMode,
    typedFailures: adapter.typedFailures,
    usagePerRequest: adapter.usagePerRequest,
  } satisfies AcpAgent;
};

export const acpAgentInstalled = (runner: RunnerId) => {
  try {
    fromPackage.resolve(RUNNERS[runner].acpEntry);

    return true;
  } catch {
    return false;
  }
};

const execFileAsync = promisify(execFile);

const CodexMcpServers = z.array(z.object({ name: z.string() }));

const ExecFailure = z.object({ stderr: z.string() });

const unlisted = (why: string) =>
  new RefusalError(
    `IdleBiz could not list your codex MCP servers to keep them out of the run (${why}), so it did not start.`,
  ) satisfies RefusalError;

/**
 * The session config turning off every MCP server `listed` (what `codex mcp list --json` printed)
 * names, and apps, plugins and memories whole, which would bring servers, skills or what the
 * founder's own sessions taught codex into the run; it reads the team's notes as a claude run is
 * handed them (`readTeamNotes`).
 */
export const codexSessionConfig = (listed: string) => {
  let servers: z.infer<typeof CodexMcpServers>;

  try {
    servers = CodexMcpServers.parse(parseJson(listed));
  } catch {
    throw unlisted("codex answered in a shape IdleBiz does not read");
  }

  const config = {
    features: { apps: false, memories: false, plugins: false },
    mcp_servers: Object.fromEntries(servers.map(({ name }) => [name, { enabled: false }])),
    project_doc_fallback_filenames: [],
    project_doc_max_bytes: TEAM_NOTES_MAX_BYTES,
  };

  return { CODEX_CONFIG: JSON.stringify(config) };
};

/**
 * The adapter env carrying `codexSessionConfig`. A session's config is merged over the founder's
 * with no switch that loads no server, so each is listed as the run would load them (`env` is the
 * run's own, a CODEX_HOME in it included) and turned off by name.
 */
export const codexSessionEnv = async (sandbox: Sandbox, env: Record<string, string> = {}) => {
  const [bin, ...rest] = sandboxedCommand(sandbox, "codex", [
    runnerBin("codex"),
    "mcp",
    "list",
    "--json",
  ]);

  let listed: string;

  try {
    ({ stdout: listed } = await execFileAsync(bin, rest, {
      env: { ...runnerEnv("codex"), ...env },
      timeout: 15_000,
    }));
  } catch (error) {
    const failed = ExecFailure.safeParse(error);
    const [said = ""] = failed.success ? failed.data.stderr.trim().split("\n", 1) : [];
    throw unlisted(said === "" ? "codex did not answer" : said);
  }

  return codexSessionConfig(listed);
};

/**
 * `runner`'s session under `sandbox`, loading the skills in `skills` and none of the founder's, nor
 * any MCP server of theirs, but signing in as their CLI does, and handed the notes the team keeps
 * in `workspace`, where it works on a product.
 */
export const sessionAgent = async (
  runner: RunnerId,
  sandbox: Sandbox,
  skills: string,
  workspace: string | null,
) => {
  if (runner === "codex") {
    const setup = { skills, teamNotes: null, userSettings: {} };

    return acpAgentFor(runner, sandbox, setup, await codexSessionEnv(sandbox));
  }

  const { env, settings } = await claudeUserSettings(sandbox.runners.claude.folder);
  const notes = workspace === null ? null : await readTeamNotes(workspace);

  const setup = {
    skills,
    teamNotes: notes === null ? null : teamNotesPrompt(notes),
    userSettings: settings,
  };

  return acpAgentFor(runner, sandbox, setup, env);
};

/**
 * What answers a run's permission ask. The runner's own judge has decided what it could before
 * asking: what reaches IdleBiz runs, since the sandbox and the vault are what hold a run. A widening
 * of codex's own sandbox never does: once widened, nothing in the run would ask again.
 */
export const permissionGate = (tool: ToolAsk) =>
  Promise.resolve({ allow: tool.kind !== "sandbox" });
