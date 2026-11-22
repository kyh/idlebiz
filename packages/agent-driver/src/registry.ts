import type { NewSessionRequest } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { RunnerId } from "@repo/domain/runners";
import type { Rates } from "./pricing";

/** A command line: the program, then its arguments. Never empty, so a spawn always has a program. */
export type Argv = readonly [bin: string, ...args: string[]];

export interface RunnerAdapter {
  /** Module specifier of the ACP subprocess. */
  acpEntry: string;
  /**
   * The mode set every turn, from the run's whole env: fresh or resumed, a session starts in a
   * default the player's own settings may pick. The runner's own judge decides what a command may
   * do where it can; the sandbox and the vault are what hold a run either way.
   */
  sessionMode: (env: Readonly<Record<string, string>>) => string;
  /**
   * How a session starts loading IdleBiz's skills and none of the player's: the `_meta` sent on
   * session/new and session/resume (the adapter's own session options), and folders it is handed
   * besides the run's own, to read.
   */
  session: (setup: SessionSetup) => SessionStart;
  /** Adapter env var pointing at the player's CLI; bundled optional binaries may be absent. */
  binEnvVar: string;
  /**
   * Prefixes of the env vars this CLI signs in and is configured with: a run's env drops
   * every other credential-shaped name, and without these the CLI could not reach its model.
   * Agent code reads them too, so keep no key that signs for more than the model.
   */
  providerEnv: readonly string[];
  /** The player's CLI on PATH, and the env var that overrides where it lives. */
  cli: { command: string; override: string };
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
   * with the `errorKind` that `classOfRequestError` reads.
   */
  typedFailures?: true;
}

const ignoredIfBad = <T extends z.ZodType>(schema: T) =>
  z
    .unknown()
    .transform((value) => schema.safeParse(value).data)
    .optional();

/**
 * What of the player's claude user settings a session still carries, by their names there, since
 * it loads none of them: what signs their CLI in, and the model and effort they picked, which
 * claude would otherwise leave for its default and bill them for. Only these, so nothing of the
 * player's can loosen what the session sets beside them.
 */
export const ClaudeUserSettingsSchema = z.object({
  alwaysThinkingEnabled: ignoredIfBad(z.boolean()),
  apiKeyHelper: z.string().optional(),
  awsAuthRefresh: z.string().optional(),
  awsCredentialExport: z.string().optional(),
  effortLevel: ignoredIfBad(z.string()),
  gcpAuthRefresh: z.string().optional(),
  model: ignoredIfBad(z.string()),
  modelOverrides: ignoredIfBad(z.record(z.string(), z.string())),
  modelSettings: ignoredIfBad(
    z.record(z.string(), z.object({ effortLevel: z.string().optional() })),
  ),
});

export type ClaudeUserSettings = z.output<typeof ClaudeUserSettingsSchema>;

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

interface SessionStart {
  meta?: NewSessionRequest["_meta"];
  /** Folders handed to the session besides the run's own, which it only reads. */
  readDirs: readonly string[];
}

const claudeAuthStatus = z.object({ loggedIn: z.boolean() });

const claudeLoggedIn = (output: string) => {
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

const claudeSession = ({ skills, teamNotes, userSettings }: SessionSetup) => {
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
          permissions: {
            deny: ["mcp__*", "EnterPlanMode", "ExitPlanMode"],
          },
          // WARNING: off, since sandbox-exec cannot nest: on, every command in a run fails.
          sandbox: { autoAllowBashIfSandboxed: false, enabled: false },
        },
        strictMcpConfig: true,
      },
    },
  };

  if (teamNotes !== null) {
    meta.systemPrompt = { append: teamNotes };
  }

  return { meta, readDirs: [] } satisfies SessionStart;
};

const codexSession = ({ skills }: SessionSetup) => ({ readDirs: [skills] }) satisfies SessionStart;

export const RUNNERS = {
  claude: {
    acpEntry: "@agentclientprotocol/claude-agent-acp/dist/index.js",
    authProbe: { args: ["auth", "status"], loggedIn: claudeLoggedIn },
    binEnvVar: "CLAUDE_CODE_EXECUTABLE",
    cli: { command: "claude", override: "CLAUDE_BIN" },
    fallbackRates: { cachedInput: 0.3, input: 3, output: 15 },
    loginArgs: ["auth", "login"],
    providerEnv: [
      "ANTHROPIC_",
      "CLAUDE_",
      "AWS_BEARER_TOKEN_BEDROCK",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ],
    session: claudeSession,
    sessionMode: (env) =>
      env.ANTHROPIC_BASE_URL === undefined || env.ANTHROPIC_BASE_URL === "" ? "auto" : "default",
  },
  codex: {
    acpEntry: "@agentclientprotocol/codex-acp/dist/index.js",
    authProbe: { args: ["login", "status"], loggedIn: (out) => !/not logged in/iu.test(out) },
    binEnvVar: "CODEX_PATH",
    cli: { command: "codex", override: "CODEX_BIN" },
    fallbackRates: { cachedInput: 0.125, input: 1.25, output: 10 },
    loginArgs: ["login"],
    providerEnv: ["OPENAI_", "CODEX_", "AWS_BEARER_TOKEN_BEDROCK", "AZURE_OPENAI_"],
    session: codexSession,
    // WARNING: the one mode with no sandbox of codex's own, since sandbox-exec cannot nest.
    sessionMode: () => "agent-full-access",
    typedFailures: true,
    usagePerRequest: true,
  },
} satisfies Record<RunnerId, RunnerAdapter>;
