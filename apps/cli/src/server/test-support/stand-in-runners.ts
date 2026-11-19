import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { RUNNERS } from "@repo/agent-driver/registry";
import { RUNNER_IDS } from "@repo/domain/runners";
import type { RunnerId } from "@repo/domain/runners";
import { errorMessage } from "@repo/domain/errors";
import { SYSTEM_PATH } from "../lib/founder-env";
import { STAND_IN_KEY } from "./stand-in-model";
import type { StandInModel } from "./stand-in-model";

const fromCli = createRequire(import.meta.url);

const resolveFrom = (from: string, specifier: string) => {
  try {
    return createRequire(from).resolve(specifier);
  } catch (error) {
    throw new Error(
      `${specifier} is not installed (${errorMessage(error)}): the CLIs the adapters bundle are optional dependencies, so reinstall without --no-optional`,
      { cause: error },
    );
  }
};

const firstFrom = (from: string, [first, ...rest]: readonly [string, ...string[]]) => {
  try {
    return resolveFrom(from, first);
  } catch (error) {
    const found = rest.flatMap((specifier) => {
      try {
        return [createRequire(from).resolve(specifier)];
      } catch {
        return [];
      }
    });

    if (found[0] === undefined) {
      throw error;
    }

    return found[0];
  }
};

const bundledClaude = () => {
  const adapter = fromCli.resolve(RUNNERS.claude.acpEntry);
  const sdk = resolveFrom(adapter, "@anthropic-ai/claude-agent-sdk");
  const own = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;

  return process.platform === "linux"
    ? firstFrom(sdk, [`${own}/claude`, `${own}-musl/claude`])
    : resolveFrom(sdk, `${own}/claude`);
};

const CODEX_TARGETS = new Map([
  ["darwin-arm64", "aarch64-apple-darwin"],
  ["darwin-x64", "x86_64-apple-darwin"],
  ["linux-arm64", "aarch64-unknown-linux-musl"],
  ["linux-x64", "x86_64-unknown-linux-musl"],
]);

const bundledCodex = () => {
  const platform = `${process.platform}-${process.arch}`;
  const target = CODEX_TARGETS.get(platform);

  if (target === undefined) {
    throw new Error(`no codex is bundled for ${platform}`);
  }

  const adapter = fromCli.resolve(RUNNERS.codex.acpEntry);
  const launcher = resolveFrom(adapter, "@openai/codex/bin/codex.js");
  const own = resolveFrom(launcher, `@openai/codex-${platform}/package.json`);
  const codex = path.join(path.dirname(own), "vendor", target, "bin", "codex");

  if (!existsSync(codex)) {
    throw new Error(`${codex} is not there: reinstall @openai/codex-${platform}`);
  }

  return codex;
};

/** The CLI `runner`'s adapter bundles; a throw saying why when it is not installed, never a skip. */
export const bundledCli = (runner: RunnerId) =>
  runner === "claude" ? bundledClaude() : bundledCodex();

const PROVIDER_ENV = RUNNER_IDS.flatMap((runner) => RUNNERS[runner].providerEnv);

/**
 * Whether `name` is one a runner's CLI signs in or is configured with: a terminal's own, handed to
 * main, could route a run on the stand-in to a real provider, and bill it.
 */
export const isProviderEnv = (name: string) =>
  PROVIDER_ENV.some((prefix) => name.startsWith(prefix));

const execFileAsync = promisify(execFile);

const signedIn = async (runner: RunnerId, url: string, scratch: string) => {
  const bin = bundledCli(runner);
  const home = path.join(scratch, runner);
  await mkdir(home, { recursive: true });

  if (runner === "claude") {
    await writeFile(path.join(home, ".claude.json"), "{}");

    return {
      ANTHROPIC_API_KEY: STAND_IN_KEY,
      ANTHROPIC_BASE_URL: url,
      CLAUDE_BIN: bin,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CONFIG_DIR: home,
      DISABLE_AUTOUPDATER: "1",
    } satisfies Record<string, string>;
  }

  await writeFile(
    path.join(home, "config.toml"),
    [
      'cli_auth_credentials_store = "file"',
      'model_provider = "stand-in"',
      "[model_providers.stand-in]",
      'name = "stand-in"',
      `base_url = "${url}/v1"`,
      'wire_api = "responses"',
    ].join("\n"),
  );

  const login = execFileAsync(bin, ["login", "--with-api-key"], {
    env: { CODEX_HOME: home, HOME: scratch, PATH: SYSTEM_PATH },
    timeout: 30_000,
  });

  login.child.stdin?.end(`${STAND_IN_KEY}\n`);
  await login;

  return { CODEX_BIN: bin, CODEX_HOME: home } satisfies Record<string, string>;
};

/**
 * Main's env for runs on the stand-in `model`: each of `runners` is the CLI its adapter bundles,
 * signed in to the stand-in under `scratch`, and every other runner's CLI is a path that is not
 * there, so no CLI of the developer's is ever looked for. That path sits in a folder of its own:
 * the sandbox keeps the folder of every CLI main names from every run, as one the founder runs
 * programs from, and the one beside the homes would keep the runners from their own state.
 */
export const standInRunnerEnv = async ({
  model,
  runners,
  scratch,
}: {
  model: Pick<StandInModel, "url">;
  runners: readonly RunnerId[];
  scratch: string;
}) => {
  const envs = await Promise.all(
    RUNNER_IDS.map(async (runner) =>
      runners.includes(runner)
        ? await signedIn(runner, model.url, scratch)
        : { [RUNNERS[runner].cli.override]: path.join(scratch, "absent", `no-${runner}`) },
    ),
  );

  return Object.fromEntries(envs.flatMap((env) => Object.entries(env)));
};
