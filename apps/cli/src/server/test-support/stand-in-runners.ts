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

// `idlebiz/stand-in-runners`, for the e2e suite and main's own tests: the claude and codex the
// adapters bundle, lockfile-pinned through the adapter catalog, each signed in to the stand-in
// model and to nothing else, in a home of its own. Every switch it sets is one the packaged shell
// drops (src-tauri/src/runtime.rs), so none of it can reach an installed app.

// the adapters are main's own dependencies, so what they bundle is found from here
const fromCli = createRequire(import.meta.url);

/** `resolve` of where `from` resolves, or a throw naming what is missing and how to get it back. */
const resolveFrom = (from: string, specifier: string): string => {
  try {
    return createRequire(from).resolve(specifier);
  } catch (error) {
    throw new Error(
      `${specifier} is not installed (${errorMessage(error)}): the CLIs the adapters bundle are optional dependencies, so reinstall without --no-optional`,
      { cause: error },
    );
  }
};

/** The first of `specifiers` that resolves from `from`, or the first one's throw. */
const firstFrom = (from: string, [first, ...rest]: readonly [string, ...string[]]): string => {
  try {
    return resolveFrom(from, first);
  } catch (error) {
    for (const specifier of rest) {
      try {
        return createRequire(from).resolve(specifier);
      } catch {
        // the first one's throw names what is missing
      }
    }
    throw error;
  }
};

/**
 * The claude bundled with the SDK claude-agent-acp drives, found as the adapter finds it (its
 * `claudeCliPath`): the SDK's own package for this platform, glibc's before musl's on Linux.
 */
const bundledClaude = (): string => {
  const adapter = fromCli.resolve(RUNNERS.claude.acpEntry);
  const sdk = resolveFrom(adapter, "@anthropic-ai/claude-agent-sdk");
  const own = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  return process.platform === "linux"
    ? firstFrom(sdk, [`${own}/claude`, `${own}-musl/claude`])
    : resolveFrom(sdk, `${own}/claude`);
};

/** The target each platform's codex is built for, as `@openai/codex`'s launcher names it. */
const CODEX_TARGETS = new Map([
  ["darwin-arm64", "aarch64-apple-darwin"],
  ["darwin-x64", "x86_64-apple-darwin"],
  ["linux-arm64", "aarch64-unknown-linux-musl"],
  ["linux-x64", "x86_64-unknown-linux-musl"],
]);

/**
 * The codex codex-acp bundles, as `@openai/codex`'s launcher finds it (`bin/codex.js`): the binary
 * in the vendor folder of its package for this platform.
 */
const bundledCodex = (): string => {
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
export const bundledCli = (runner: RunnerId): string =>
  runner === "claude" ? bundledClaude() : bundledCodex();

const execFileAsync = promisify(execFile);

/**
 * `runner`'s CLI signed in to the stand-in at `url`, in a home of its own under `scratch`: its env.
 * claude takes the stand-in's key from its env, and a home with its account file already there,
 * which a sealed run cannot create. codex signs in once, here, unsealed, with nothing of main's
 * env: a setup step, never a run, and its login lands in a file, since codex runs are denied the
 * Keychain.
 */
const signedIn = async (
  runner: RunnerId,
  url: string,
  scratch: string,
): Promise<Record<string, string>> => {
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
    };
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
  return { CODEX_BIN: bin, CODEX_HOME: home };
};

/**
 * Main's env for runs on the stand-in `model`: each of `runners` is the CLI its adapter bundles,
 * signed in to the stand-in under `scratch`, and every other runner's CLI is a path that is not
 * there, so no CLI of the developer's is ever looked for.
 */
export const standInRunnerEnv = async ({
  model,
  runners,
  scratch,
}: {
  model: Pick<StandInModel, "url">;
  runners: readonly RunnerId[];
  scratch: string;
}): Promise<Record<string, string>> => {
  const envs = await Promise.all(
    RUNNER_IDS.map(async (runner) =>
      runners.includes(runner)
        ? await signedIn(runner, model.url, scratch)
        : { [RUNNERS[runner].cli.override]: path.join(scratch, `no-${runner}`) },
    ),
  );
  return Object.fromEntries(envs.flatMap((env) => Object.entries(env)));
};
