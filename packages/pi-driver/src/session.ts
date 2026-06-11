import { mkdirSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type {
  AgentSession,
  AuthStorage,
  ModelRegistry,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";

export interface PiSessionConfig {
  /** Working directory the agent operates in (created if missing). */
  cwd: string;
  /** The agent's package dir — its AGENTS.md doubles as the instructions pi reads. */
  agentDir: string;
  /** Where session files persist (created if missing); most-recent is continued. */
  sessionDir: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: Model<Api>;
  thinkingLevel: "off" | "low" | "medium" | "high";
  customTools: ToolDefinition[];
}

/** Create (or continue) a pi agent session with idlebiz's standard layout. */
export async function createPiSession(cfg: PiSessionConfig): Promise<AgentSession> {
  mkdirSync(cfg.cwd, { recursive: true });
  mkdirSync(cfg.sessionDir, { recursive: true });

  const resourceLoader = new DefaultResourceLoader({
    cwd: cfg.cwd,
    agentDir: cfg.agentDir,
    extensionFactories: [],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: cfg.cwd,
    agentDir: cfg.agentDir,
    authStorage: cfg.authStorage,
    modelRegistry: cfg.modelRegistry,
    resourceLoader,
    model: cfg.model,
    thinkingLevel: cfg.thinkingLevel,
    sessionManager: SessionManager.continueRecent(cfg.cwd, cfg.sessionDir),
    settingsManager: SettingsManager.create(cfg.cwd, cfg.agentDir),
    customTools: cfg.customTools,
  });
  return session;
}
