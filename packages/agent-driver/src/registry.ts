import type { NewSessionRequest } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { Rates } from "./pricing";
import type { RunnerId } from "./runner";

export interface RunnerAdapter {
  /** Module specifier of the ACP subprocess. */
  acpEntry: string;
  /**
   * Mode that raises permission requests, set every turn: fresh or resumed, a session
   * starts in a default that may skip the founder gate — codex's own, or the
   * `permissions.defaultMode` claude reads from the player's user, project or local settings.
   */
  sessionModeId: string;
  /**
   * How a session starts loading IdleBiz's skills and none of the player's: the `_meta` sent on
   * session/new and session/resume (the adapter's own session options), and folders it is handed
   * besides the run's own, to read.
   */
  session: (setup: SessionSetup) => SessionStart;
  /** Adapter env var pointing at the player's CLI; bundled optional binaries may be absent. */
  binEnvVar?: string;
  /**
   * Prefixes of the env vars this CLI signs in and is configured with: a run's env drops
   * every other credential-shaped name, and without these the CLI could not reach its model.
   * Agent code reads them too, so keep no key that signs for more than the model.
   */
  providerEnv: readonly string[];
  /** The player's CLI on PATH, and the env var that overrides where it lives. */
  cli: { command: string; override: string };
  displayName: string;
  loginArgs: string[];
  authProbe: { args: string[]; loggedIn: (output: string) => boolean };
  /** What the CLI's default model costs, for pricing a run that reports $0. */
  fallbackRates: Rates;
  /**
   * The prompt response's usage covers only the turn's last model request, and one
   * usage_update arrives per request (codex-acp), so the turn is counted from their sum.
   */
  usagePerRequest?: true;
  /**
   * Declare the adapter's typed session failures on initialize. Undeclared, codex-acp tells a
   * failed turn only in prose and still ends it `end_turn`, which reads as finished work.
   * claude-agent-acp speaks them too, but declared, it would stop rejecting a limited turn
   * with the `errorKind` that `limitOf` parks on.
   */
  typedFailures?: true;
}

/**
 * What of the player's claude user settings a session still carries, by their names there, since
 * it loads none of them: what signs their CLI in, and the model and effort they picked, which
 * claude would otherwise leave for its default and bill them for. Only these, so nothing of the
 * player's can loosen what the session sets beside them.
 */
export interface ClaudeUserSettings {
  alwaysThinkingEnabled?: boolean;
  apiKeyHelper?: string;
  awsAuthRefresh?: string;
  awsCredentialExport?: string;
  effortLevel?: string;
  gcpAuthRefresh?: string;
  model?: string;
  modelOverrides?: Readonly<Record<string, string>>;
  modelSettings?: Readonly<Record<string, { effortLevel?: string }>>;
}

/**
 * What of a session's start is the run's to say. `skills` is the folder of IdleBiz's skills, each
 * at `.agents/skills/<name>/SKILL.md` in it: codex-acp takes skills only from `.agents/skills` in
 * a folder a session is handed, and `.agents` is also a claude plugin (its manifest in
 * `.claude-plugin/`), whose skills are that same folder.
 */
export interface SessionSetup {
  skills: string;
  userSettings: ClaudeUserSettings;
  /**
   * The notes the team keeps in AGENTS.md at the root of the run's workspace, framed for the
   * model, or null for none. codex reads that file itself, so only a claude session, which loads
   * no project instructions, is handed them, beside its system prompt.
   */
  teamNotes: string | null;
}

export interface SessionStart {
  meta?: NewSessionRequest["_meta"];
  /** Folders handed to the session besides the run's own, which it only reads. */
  readDirs: readonly string[];
}

const claudeAuthStatus = z.object({ loggedIn: z.boolean() });

/** `claude auth status` prints JSON with a loggedIn flag, after whatever else it says. */
const claudeLoggedIn = (output: string): boolean => {
  const start = output.indexOf("{");
  if (start === -1) {
    return false;
  }
  try {
    const parsed = claudeAuthStatus.safeParse(
      JSON.parse(output.slice(start, output.lastIndexOf("}") + 1)),
    );
    return parsed.success && parsed.data.loggedIn;
  } catch {
    return false;
  }
};

/**
 * With bypass off, no settings tier can start a session in it. No setting source is loaded: not
 * the player's user settings (their CLAUDE.md, skills, plugins, hooks), nor a project's or a
 * local one, which a run could write for the next to load. What remains is managed policy and
 * `settings`, the flag tier, whose ask rules beat allow rules from any tier. Its skills are
 * IdleBiz's, as a plugin, and none of claude's own. None of the player's MCP servers or claude.ai
 * connectors load either: those act as the player, signed in as them, and a run reaches the
 * company with the `idlebiz` command in its shell, not MCP.
 */
const claudeSession = ({ skills, teamNotes, userSettings }: SessionSetup): SessionStart => {
  const meta: NonNullable<SessionStart["meta"]> = {
    claudeCode: {
      options: {
        allowDangerouslySkipPermissions: false,
        plugins: [{ path: `${skills}/.agents`, type: "local" }],
        settingSources: [],
        settings: {
          ...userSettings,
          disableBundledSkills: true,
          disableClaudeAiConnectors: true,
          // Plan mode's exit asks to approve a plan: IdleBiz would hold that for the founder to
          // sign, blocking the task over a step that changes no boundary.
          permissions: {
            ask: ["Bash", "Edit", "Write", "NotebookEdit"],
            deny: ["mcp__*", "EnterPlanMode", "ExitPlanMode"],
          },
          // Off: the run is already inside a Seatbelt profile, and one cannot apply inside
          // another. On, every command would fail, and a sandboxed one would skip the Bash ask.
          sandbox: { autoAllowBashIfSandboxed: false, enabled: false },
        },
        strictMcpConfig: true,
      },
    },
  };
  if (teamNotes !== null) {
    meta.systemPrompt = { append: teamNotes };
  }
  return { meta, readDirs: [] };
};

/**
 * codex has no setting that leaves all the player's skills out: the seal keeps its runs from
 * reading them, and their plugins' are left out with plugins. codex-acp hands `.agents/skills` in
 * each folder a session is handed to codex as a skill root, so IdleBiz's folder is handed over.
 */
const codexSession = ({ skills }: SessionSetup): SessionStart => ({ readDirs: [skills] });

export const RUNNERS = {
  claude: {
    acpEntry: "@agentclientprotocol/claude-agent-acp/dist/index.js",
    authProbe: { args: ["auth", "status"], loggedIn: claudeLoggedIn },
    binEnvVar: "CLAUDE_CODE_EXECUTABLE",
    cli: { command: "claude", override: "CLAUDE_BIN" },
    displayName: "Claude Code",
    fallbackRates: { cachedInput: 0.3, input: 3, output: 15 },
    loginArgs: ["auth", "login"],
    // Bedrock's bearer token signs only for Bedrock, AWS access keys for the whole account, and
    // the seal hides ~/.aws, so Bedrock is only that token; Vertex reads the path of Google's key
    // file, which works only outside the sealed logins (not gcloud's default credentials)
    providerEnv: [
      "ANTHROPIC_",
      "CLAUDE_",
      "AWS_BEARER_TOKEN_BEDROCK",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ],
    session: claudeSession,
    sessionModeId: "default",
  },
  codex: {
    acpEntry: "@agentclientprotocol/codex-acp/dist/index.js",
    // `codex login status` exits 0 either way and says how you're logged in
    authProbe: { args: ["login", "status"], loggedIn: (out) => !/not logged in/iu.test(out) },
    binEnvVar: "CODEX_PATH",
    cli: { command: "codex", override: "CODEX_BIN" },
    displayName: "Codex",
    fallbackRates: { cachedInput: 0.125, input: 1.25, output: 10 },
    loginArgs: ["login"],
    // Bedrock as for claude; the Azure provider codex documents reads AZURE_OPENAI_API_KEY
    providerEnv: ["OPENAI_", "CODEX_", "AWS_BEARER_TOKEN_BEDROCK", "AZURE_OPENAI_"],
    session: codexSession,
    // Added by the app's patch of codex-acp (patches/): no sandbox of codex's own, which cannot
    // start inside the run's, and approval "untrusted", so codex asks before every command and
    // patch it does not know is safe. codex-acp's own modes either sandbox or never ask.
    sessionModeId: "external-sandbox",
    typedFailures: true,
    usagePerRequest: true,
  },
} satisfies Record<RunnerId, RunnerAdapter>;
