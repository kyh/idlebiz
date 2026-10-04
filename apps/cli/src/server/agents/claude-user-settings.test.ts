import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeUserSettings } from "./claude-user-settings";

describe("claudeUserSettings", () => {
  let configDir = "";

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "idlebiz-claude-user-settings-"));
  });

  afterEach(() => {
    rmSync(configDir, { force: true, recursive: true });
  });

  const settle = (json: string): void => {
    writeFileSync(path.join(configDir, "settings.json"), json);
  };

  it("carries a sign-in kept in the founder's settings, as their shell's would reach a run", async () => {
    const settings = {
      apiKeyHelper: "~/bin/anthropic-key",
      awsAuthRefresh: "aws sso login",
      env: {
        ANTHROPIC_VERTEX_PROJECT_ID: "acme",
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
        AWS_REGION: "us-east-1",
        CLAUDE_CODE_USE_BEDROCK: "1",
        GH_TOKEN: "founder-gh",
        HTTPS_PROXY: "http://proxy.corp:8080",
        MAX_THINKING_TOKENS: 1024,
      },
      hooks: { Stop: [] },
      permissions: { allow: ["Bash"] },
    };
    settle(JSON.stringify(settings));
    expect(await claudeUserSettings(configDir)).toEqual({
      env: {
        ANTHROPIC_VERTEX_PROJECT_ID: "acme",
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
        AWS_REGION: "us-east-1",
        CLAUDE_CODE_USE_BEDROCK: "1",
        HTTPS_PROXY: "http://proxy.corp:8080",
        MAX_THINKING_TOKENS: "1024",
      },
      settings: { apiKeyHelper: "~/bin/anthropic-key", awsAuthRefresh: "aws sso login" },
    });
  });

  it("carries the model and effort the founder picked, so a run is billed for what they chose", async () => {
    const choice = {
      alwaysThinkingEnabled: false,
      effortLevel: "high",
      model: "haiku",
      modelOverrides: { "claude-opus-5-5": "arn:aws:bedrock:us-east-1:1:inference-profile/opus" },
      modelSettings: { "claude-opus-5": { effortLevel: "xhigh" } },
    };
    settle(JSON.stringify({ ...choice, availableModels: ["haiku"], theme: "dark" }));
    expect(await claudeUserSettings(configDir)).toEqual({ env: {}, settings: choice });
  });

  it("leaves out a model choice claude could not read, and still signs in", async () => {
    settle(JSON.stringify({ apiKeyHelper: "~/bin/key", effortLevel: 3, model: ["haiku"] }));
    expect(await claudeUserSettings(configDir)).toEqual({
      env: {},
      settings: { apiKeyHelper: "~/bin/key" },
    });
  });

  it("carries nothing from settings that are missing or that claude could not read either", async () => {
    const none = { env: {}, settings: {} };
    expect(await claudeUserSettings(configDir)).toEqual(none);
    settle("{ not json");
    expect(await claudeUserSettings(configDir)).toEqual(none);
    settle(JSON.stringify({ apiKeyHelper: 7, env: "CLAUDE_CODE_USE_BEDROCK=1" }));
    expect(await claudeUserSettings(configDir)).toEqual(none);
  });
});
