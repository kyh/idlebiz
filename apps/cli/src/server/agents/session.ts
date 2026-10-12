import { runnerBin } from "@repo/agent-driver/detect";
import { RUNNERS } from "@repo/agent-driver/registry";
import type { RunnerAdapter, SessionSetup } from "@repo/agent-driver/registry";
import type {
  AcpAgent,
  PermissionDecision,
  PermissionRequest,
} from "@repo/agent-driver/acp-session";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { BlockedAsk } from "@repo/domain/domain";
import { isLeased } from "@repo/domain/hold-rules";
import { parseJson } from "@repo/domain/json";
import type { RunnerId } from "@repo/domain/runners";
import { holdFor } from "../policy";
import type { BrowserCli, Confinement, LivePage } from "../policy/browser";
import { teamNotesPrompt } from "../prompts/team-notes";
import { RefusalError } from "../refusal";
import * as store from "../store/store";
import { DEPLOY_TIMEOUT_MS } from "../tool-specs";
import { claudeUserSettings } from "./claude-user-settings";
import { runEnv } from "./run-env";
import { runTmpdir } from "./run-workspace";
import { browserSocketDir, namespaceUnder, SANDBOX_EXEC, sealedCommand } from "./seal";
import type { Seal } from "./seal";
import { TEAM_NOTES_MAX_BYTES, readTeamNotes } from "./team-notes";

// The desktop app ships the ACP binaries, so resolve them against its node_modules.
const resolveFromApp = createRequire(import.meta.url);

/** What of main's env a runner's CLI gets, for a run or a probe of its login alike. */
export const runnerEnv = (runner: RunnerId): Record<string, string> =>
  runEnv(process.env, RUNNERS[runner].providerEnv);

/**
 * Chrome's own sandbox is one more that cannot start inside the seal. No AGENT_BROWSER_PROFILE:
 * unset, each session's Chrome gets a fresh profile under TMPDIR, never the founder's, while one
 * fixed profile would keep every session but the first from starting, since Chrome locks it.
 * The namespace is that of the run's runner and folders, and so are its daemons: only such runs,
 * or a read made the way one of them would make it, ever start one there. A screenshot named no
 * path lands in the runs' temp folder, not agent-browser's own in HOME, which no run writes.
 */
const browserEnv = (seal: Seal, runner: RunnerId) => ({
  AGENT_BROWSER_ARGS: "--no-sandbox",
  AGENT_BROWSER_NAMESPACE: namespaceUnder(seal, runner),
  AGENT_BROWSER_SCREENSHOT_DIR: path.join(runTmpdir(), "screenshots"),
  AGENT_BROWSER_SOCKET_DIR: browserSocketDir(),
});

/** The folder the daemons of `runner`'s runs under `seal` listen in, which a run cannot make: only write inside it. */
export const makeBrowserNamespace = (seal: Seal, runner: RunnerId): void => {
  mkdirSync(seal.namespaces[runner].path, { recursive: true });
};

/**
 * `runner`'s agent under `seal`, for a task's session or a one-shot's alike. `setup` is where
 * IdleBiz's skills are, and how the founder's claude signs in and which model it picks. `more`
 * joins the adapter's env over main's: codex's session config, or claude's user-settings env.
 */
export const acpAgentFor = (
  runner: RunnerId,
  seal: Seal,
  setup: SessionSetup,
  more: Record<string, string> = {},
): AcpAgent => {
  const adapter: RunnerAdapter = RUNNERS[runner];
  const session = adapter.session(setup);
  const env: AcpAgent["env"] = {
    ...runnerEnv(runner),
    ...more,
    ...browserEnv(seal, runner),
  };
  if (adapter.binEnvVar) {
    env[adapter.binEnvVar] = runnerBin(runner);
  }
  if (runner === "claude") {
    // claude kills a shell command after 2 minutes by default: `idlebiz deploy` would die before
    // Vercel answers, with the founder's sign-off already spent on it
    env.BASH_DEFAULT_TIMEOUT_MS = String(DEPLOY_TIMEOUT_MS + 60_000);
  }
  return {
    command: sealedCommand(seal, runner, [
      process.execPath,
      resolveFromApp.resolve(adapter.acpEntry),
    ]),
    env,
    readDirs: session.readDirs,
    sessionMeta: session.meta,
    sessionModeId: adapter.sessionModeId,
    typedFailures: adapter.typedFailures,
    usagePerRequest: adapter.usagePerRequest,
  };
};

export const acpAgentInstalled = (runner: RunnerId): boolean => {
  try {
    resolveFromApp.resolve(RUNNERS[runner].acpEntry);
    return true;
  } catch {
    return false;
  }
};

const execFileAsync = promisify(execFile);

const CodexMcpServers = z.array(z.object({ name: z.string() }));

const ExecFailure = z.object({ stderr: z.string() });

/** Why codex could not list its servers, in words the founder can act on. */
const unlisted = (why: string): RefusalError =>
  new RefusalError(
    `IdleBiz could not list your codex MCP servers to keep them out of the run (${why}), so it did not start.`,
  );

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
export const codexSessionEnv = async (
  seal: Seal,
  env: Record<string, string> = {},
): Promise<Record<string, string>> => {
  const [bin = SANDBOX_EXEC, ...rest] = sealedCommand(seal, "codex", [
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
 * `runner`'s session under `seal`, loading the skills in `skills` and none of the founder's, nor
 * any MCP server of theirs, but signing in as their CLI does, and handed the notes the team keeps
 * in `workspace`, where it works on a product.
 */
export const sessionAgent = async (
  runner: RunnerId,
  seal: Seal,
  skills: string,
  workspace: string | null,
): Promise<AcpAgent> => {
  if (runner === "codex") {
    const setup = { skills, teamNotes: null, userSettings: {} };
    return acpAgentFor(runner, seal, setup, await codexSessionEnv(seal));
  }
  const { env, settings } = await claudeUserSettings(seal.runners.claude.folder);
  const notes = workspace === null ? null : await readTeamNotes(workspace);
  const setup = {
    skills,
    teamNotes: notes === null ? null : teamNotesPrompt(notes),
    userSettings: settings,
  };
  return acpAgentFor(runner, seal, setup, env);
};

/** agent-browser as a `runner` run starts it: under its seal, in its env. */
export const sealedBrowser =
  (seal: Seal, runner: RunnerId): BrowserCli =>
  async (args) => {
    const [bin = SANDBOX_EXEC, ...rest] = sealedCommand(seal, runner, ["agent-browser", ...args]);
    const env = { ...runnerEnv(runner), ...browserEnv(seal, runner) };
    const { stdout } = await execFileAsync(bin, rest, { env, timeout: 8000 });
    return stdout;
  };

/**
 * What answers each permission ask of one attempt at task `taskId`. An approval permits one
 * execution of the exact command, or — for a site or a server — the rest of the attempt, which
 * the gate's leases hold, so build one per attempt.
 */
export const permissionGate = ({
  confinement,
  hold,
  livePage,
  taskId,
}: {
  confinement: Confinement;
  hold: (ask: BlockedAsk) => void;
  livePage: LivePage;
  taskId: string;
}) => {
  const leases = new Set<string>();
  return async (
    request: PermissionRequest,
    turnEnded: AbortSignal,
  ): Promise<PermissionDecision> => {
    if (request.tool.kind === "sandbox") {
      return { allow: false };
    }
    const held = await holdFor(request.tool, leases, livePage, confinement);
    // reading the browser can outlast the turn; its sign-off and its ask belong to a live one
    if (turnEnded.aborted) {
      return { allow: false };
    }
    if (held === null) {
      return { allow: true };
    }
    if (store.consumeApproval(taskId, held.key)) {
      if (isLeased(held.rule)) {
        leases.add(held.key);
      }
      return { allow: true };
    }
    hold({ command: held.key, rule: held.rule, type: "approval" });
    return { allow: false };
  };
};
