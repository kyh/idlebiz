import { existsSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, defineConfig, isRunnableDevEnvironment } from "vite";
import type { Plugin, RunnableDevEnvironment, ViteDevServer } from "vite";
import { pagePolicy } from "@repo/contract/page-policy";
import { DEV_PORT } from "@repo/contract/routes";
import { errorMessage } from "@repo/domain/errors";
import type { HireCandidate } from "@repo/domain/hire";
import { RUNNER_IDS } from "@repo/domain/runners";
import type { RunnerId } from "@repo/domain/runners";
import type * as DevHostModule from "idlebiz/dev-host";
import type { DevHost, DevHostOptions } from "idlebiz/dev-host";
import type * as StandInModelModule from "idlebiz/stand-in-model";
import type { StandInModel } from "idlebiz/stand-in-model";
import type * as StandInRunnersModule from "idlebiz/stand-in-runners";

const configDir = import.meta.dirname;

const devContentSecurityPolicy = () =>
  ({
    apply: "serve",
    name: "idlebiz-dev-content-security-policy",
    transformIndexHtml: () => [
      {
        attrs: {
          content: pagePolicy({ connect: [`ws://localhost:${DEV_PORT}`], meta: true }),
          "http-equiv": "Content-Security-Policy",
        },
        injectTo: "head",
        tag: "meta",
      },
    ],
  }) satisfies Plugin;

interface Watching {
  close: () => Promise<void>;
}

const watchServer = async (rebuilt: () => void) => {
  const watcher = await build({
    build: { watch: {} },
    configFile: path.resolve(configDir, "../cli/vite.config.ts"),
  });

  if (!("on" in watcher)) {
    throw new Error("the server's watch build answered with no watcher");
  }

  const { promise: firstBuild, reject, resolve } = Promise.withResolvers<true>();
  let built = false;
  watcher.on("event", (event) => {
    if (event.code === "END") {
      if (built) {
        rebuilt();
      }

      built = true;
      resolve(true);
    } else if (event.code === "ERROR" && !built) {
      reject(event.error);
    }
  });

  try {
    await firstBuild;
  } catch (error) {
    await watcher.close();
    throw error;
  }

  return { close: async () => await watcher.close() } satisfies Watching;
};

const STAND_IN_SWITCH = "IDLEBIZ_STAND_IN";

const STAND_IN_TEAM: readonly HireCandidate[] = [
  {
    blurb: "Picks the next bet from the real numbers.",
    name: "Ada",
    persona: "A calm general manager who decides what the team bets on and hands out the work.",
    role: "lead",
    title: "General Manager",
  },
  {
    blurb: "Ships small, working slices.",
    name: "Bo",
    persona: "A founding engineer who builds the product and ships it in small, working slices.",
    role: "engineer",
    title: "Founding Engineer",
  },
  {
    blurb: "Finds the product's first buyers.",
    name: "Cy",
    persona: "A growth marketer who finds where the product's buyers are and brings them to it.",
    role: "marketer",
    title: "Growth Lead",
  },
];

const isFolder = (root: string, founders: string) => {
  if (path.resolve(root) === founders) {
    return true;
  }

  const named = statSync(root, { throwIfNoEntry: false });
  const theirs = statSync(founders, { throwIfNoEntry: false });

  return (
    named !== undefined &&
    theirs !== undefined &&
    named.dev === theirs.dev &&
    named.ino === theirs.ino
  );
};

const standInRoot = (mode: string) => {
  const switched = process.env[STAND_IN_SWITCH] ?? "";

  if (switched === "") {
    return null;
  }

  if (switched !== "1") {
    throw new Error(
      `${STAND_IN_SWITCH} takes 1 or nothing, never ${JSON.stringify(switched)}: with any other value main would run on your own CLIs' logins`,
    );
  }

  if (mode !== "browser") {
    throw new Error(
      `${STAND_IN_SWITCH}=1 is \`pnpm dev:browser\`'s alone: the app's window starts main on your own CLIs' logins, so unset it here`,
    );
  }

  const founders = path.join(homedir(), ".idlebiz");
  const root = process.env.IDLEBIZ_ROOT_DIR ?? "";

  if (root === "" || isFolder(root, founders)) {
    throw new Error(
      `${STAND_IN_SWITCH}=1 needs IDLEBIZ_ROOT_DIR to name a save of its own, never ${founders}, whose queued work the stand-in would settle as done with nothing done: IDLEBIZ_ROOT_DIR="$(mktemp -d)"`,
    );
  }

  return path.resolve(root);
};

const CLAUDE_MANAGED = "/Library/Application Support/ClaudeCode";

const standInRunners = () => {
  const runners: readonly RunnerId[] = ["managed-settings.json", "managed-settings.d"].some(
    (name) => existsSync(path.join(CLAUDE_MANAGED, name)),
  )
    ? RUNNER_IDS.filter((runner) => runner !== "claude")
    : RUNNER_IDS;

  return runners;
};

interface StandIn {
  main: Pick<DevHostOptions, "env" | "inherit" | "root">;
  close: () => Promise<void>;
}

const startStandIn = async (
  ssr: RunnableDevEnvironment,
  root: string,
  log: (line: string) => void,
) => {
  const { startStandInModel } =
    await ssr.runner.import<typeof StandInModelModule>("idlebiz/stand-in-model");

  const { isProviderEnv, standInRunnerEnv } = await ssr.runner.import<typeof StandInRunnersModule>(
    "idlebiz/stand-in-runners",
  );

  const scratch = await mkdtemp(path.join(tmpdir(), "idlebiz-stand-in-"));

  const clear = () => {
    rmSync(scratch, { force: true, recursive: true });
  };

  const interrupted = () => {
    clear();
    process.kill(process.pid, "SIGINT");
  };

  process.once("exit", clear);
  process.once("SIGINT", interrupted);
  let model: StandInModel | null = null;

  const close = async () => {
    process.off("exit", clear);
    process.off("SIGINT", interrupted);

    try {
      await model?.close();
    } finally {
      clear();
    }
  };

  try {
    model = await startStandInModel();
    model.hires(null, STAND_IN_TEAM);
    const runners = standInRunners();
    const env = await standInRunnerEnv({ model, runners, scratch });
    log(
      `[stand-in] ${runners.join(" and ")} reach the stand-in model at ${model.url} alone: casting finds ${STAND_IN_TEAM.map(({ name }) => name).join(", ")} for any company, and every run ends on "done"`,
    );

    if (!runners.includes("claude")) {
      log(
        `[stand-in] claude's managed settings in ${CLAUDE_MANAGED} outrank the stand-in's sign-in on this Mac, so claude is left out`,
      );
    }

    return {
      close,
      main: {
        env,
        inherit: (name) => name !== STAND_IN_SWITCH && !isProviderEnv(name),
        root,
      },
    } satisfies StandIn;
  } catch (error) {
    await close();
    throw error;
  }
};

const devServer = (mode: string) =>
  ({
    apply: "serve",
    configureServer: async (server: ViteDevServer) => {
      const standInSave = standInRoot(mode);
      let host: DevHost | null = null;
      let standIn: StandIn | null = null;

      const watching = await watchServer(() => {
        const running = host;

        if (running === null) {
          return;
        }

        server.config.logger.info("[host] main changed: restarting it");
        void (async () => {
          try {
            await running.restartMain();
          } catch (error) {
            server.config.logger.error(`[host] main did not start again: ${errorMessage(error)}`);
          }
        })();
      });

      server.httpServer?.once("close", () => {
        void (async () => {
          const [watchStopped, hostStopped] = await Promise.allSettled([
            watching.close(),
            host?.stop(),
          ]);

          if (watchStopped.status === "rejected") {
            server.config.logger.error(
              `[build] main's watch build could not stop: ${errorMessage(watchStopped.reason)}`,
            );
          }

          if (hostStopped.status === "rejected") {
            server.config.logger.error(
              `[host] could not stop: ${errorMessage(hostStopped.reason)}`,
            );
          }

          try {
            await standIn?.close();
          } catch (error) {
            server.config.logger.error(`[stand-in] could not stop: ${errorMessage(error)}`);
          }
        })();
      });

      if (mode !== "browser") {
        return;
      }

      const { ssr } = server.environments;

      if (!isRunnableDevEnvironment(ssr)) {
        throw new Error("the dev server cannot run the dev host");
      }

      const { startDevHost } = await ssr.runner.import<typeof DevHostModule>("idlebiz/dev-host");

      const log = (line: string) => {
        server.config.logger.info(line);
      };

      const standing = standInSave === null ? null : await startStandIn(ssr, standInSave, log);
      let started: DevHost;

      try {
        started = await startDevHost({
          ...standing?.main,
          log,
          pageDevUrl: `http://localhost:${DEV_PORT}`,
        });
      } catch (error) {
        await standing?.close();
        throw error;
      }

      host = started;
      standIn = standing;
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/" || request.method !== "GET") {
          next();

          return;
        }

        void (async () => {
          try {
            response.writeHead(303, {
              "cache-control": "no-store",
              location: await started.handoff(),
            });
            response.end();
          } catch (error) {
            response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
            response.end(`IdleBiz's main is not up yet (${errorMessage(error)}): try again.`);
          }
        })();
      });
      server.httpServer?.once("listening", () => {
        server.config.logger.info(`\n  IdleBiz in a browser: http://localhost:${DEV_PORT}/\n`);
      });
    },
    name: "idlebiz-dev-server",
  }) satisfies Plugin;

export default defineConfig(({ mode }) => ({
  build: {
    emptyOutDir: true,
    outDir: path.resolve(configDir, "dist"),
    target: "safari16.6",
  },
  clearScreen: false,
  plugins: [tailwindcss(), react(), devContentSecurityPolicy(), devServer(mode)],
  publicDir: path.resolve(configDir, "public"),
  resolve: { tsconfigPaths: true },
  root: path.resolve(configDir, "src/renderer"),
  server: {
    hmr: { clientPort: DEV_PORT, host: "localhost" },
    port: DEV_PORT,
    strictPort: true,
  },
}));
