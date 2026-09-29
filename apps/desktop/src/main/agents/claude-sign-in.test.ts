import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeSignIn } from "./claude-sign-in";

describe("claudeSignIn", () => {
  let configDir = "";

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "idlebiz-claude-sign-in-"));
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
    expect(await claudeSignIn(configDir)).toEqual({
      env: {
        ANTHROPIC_VERTEX_PROJECT_ID: "acme",
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
        AWS_REGION: "us-east-1",
        CLAUDE_CODE_USE_BEDROCK: "1",
        HTTPS_PROXY: "http://proxy.corp:8080",
        MAX_THINKING_TOKENS: "1024",
      },
      helpers: { apiKeyHelper: "~/bin/anthropic-key", awsAuthRefresh: "aws sso login" },
    });
  });

  it("carries nothing from settings that are missing or that claude could not read either", async () => {
    const none = { env: {}, helpers: {} };
    expect(await claudeSignIn(configDir)).toEqual(none);
    settle("{ not json");
    expect(await claudeSignIn(configDir)).toEqual(none);
    settle(JSON.stringify({ apiKeyHelper: 7, env: "CLAUDE_CODE_USE_BEDROCK=1" }));
    expect(await claudeSignIn(configDir)).toEqual(none);
  });
});
