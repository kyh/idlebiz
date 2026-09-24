import { RUNNERS } from "@repo/agent-driver/registry";
import { describe, expect, it } from "vitest";
import { runEnv } from "./run-env";

const PROVIDERS = ["ANTHROPIC_", "OPENAI_"];

describe("runEnv", () => {
  it("drops every variable named like a credential", () => {
    const dropped = [
      "GH_TOKEN",
      "NPM_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_ACCESS_KEY_ID",
      "VERCEL_TOKEN",
      "STRIPE_SECRET_KEY",
      "HOMEBREW_GITHUB_API_TOKEN",
      "X_AUTH",
      "db_password",
      "MAILGUN_APIKEY",
      "DEPLOY_PRIVATE_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "STRIPE_KEY",
      "STRIPE_LIVE_KEY",
      "RESEND_KEY",
      "DEPLOY_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "GITHUB_PAT",
      "SENTRY_DSN",
      "SLACK_WEBHOOK_URL",
    ];
    const env = runEnv(Object.fromEntries(dropped.map((name) => [name, "secret"])), PROVIDERS);
    expect(env).toEqual({});
  });

  it("keeps the rest, the runner's own login and the ssh agent", () => {
    const base = {
      ANTHROPIC_API_KEY: "sk-ant",
      API_URL: "https://api.example.com/v1",
      GIT_AUTHOR_NAME: "Kai",
      HOME: "/Users/kai",
      KEYCHAIN: "login",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "sk-openai",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      TOKENIZERS_PARALLELISM: "false",
    };
    expect(runEnv(base, PROVIDERS)).toEqual(base);
  });

  it("drops a URL with a login in it, whatever its name, but not the proxy runs reach out through", () => {
    const base = {
      DATABASE_URL: "postgres://app:hunter2@db.internal:5432/prod",
      HTTPS_PROXY: "http://kai:pw@proxy.corp:8080",
      REDIS_URL: "redis://:hunter2@cache:6379",
      SITE_URL: "https://acme.vercel.app",
      https_proxy: "http://kai:pw@proxy.corp:8080",
    };
    expect(runEnv(base, PROVIDERS)).toEqual({
      HTTPS_PROXY: "http://kai:pw@proxy.corp:8080",
      SITE_URL: "https://acme.vercel.app",
      https_proxy: "http://kai:pw@proxy.corp:8080",
    });
  });

  it("keeps a provider's key only for the runner that names it", () => {
    const base = { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-openai" };
    expect(runEnv(base, ["OPENAI_"])).toEqual({ OPENAI_API_KEY: "sk-openai" });
  });

  it.each(Object.values(RUNNERS))("gives $displayName no AWS key but Bedrock's own", (runner) => {
    const base = {
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock",
      AWS_PROFILE: "founder",
      AWS_REGION: "us-east-1",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "session",
    };
    expect(runEnv(base, runner.providerEnv)).toEqual({
      AWS_BEARER_TOKEN_BEDROCK: "bedrock",
      AWS_PROFILE: "founder",
      AWS_REGION: "us-east-1",
    });
  });

  it("leaves out variables that are unset", () => {
    expect(runEnv({ PATH: "/usr/bin", UNSET: undefined }, [])).toEqual({ PATH: "/usr/bin" });
  });
});
