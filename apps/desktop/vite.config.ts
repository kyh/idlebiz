// The dev server answers the page's files to main, which hands them on, so the page keeps main's
// origin and still reloads in place; its hot-reload socket dials this server directly.

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

// Main stamps no policy on the page Vite answers, whose hot reload runs inline scripts, so the dev
// server writes the page's own into it, opened to its socket. At the end of the head: a meta policy
// covers only what follows it, and the dev server's own preamble for React's refresh is inline.
const devContentSecurityPolicy = (): Plugin => ({
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
});

interface Watching {
  close: () => Promise<void>;
}

/** Builds the server, resolving once the first build is out; each later one calls `rebuilt`. */
const watchServer = async (rebuilt: () => void): Promise<Watching> => {
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
    // nothing will close a watcher whose first build failed but this
    await watcher.close();
    throw error;
  }
  return { close: async () => await watcher.close() };
};

/**
 * `IDLEBIZ_STAND_IN=1 pnpm dev:browser` runs main's every turn on the stand-in model, so onboarding
 * and the office cost no login and no bill. This server alone reads it: main inherits none of it,
 * the packaged shell drops it as a developer's switch (DEVELOPER_ONLY), and nothing shipped reads
 * it.
 */
const STAND_IN_SWITCH = "IDLEBIZ_STAND_IN";

/**
 * Who casting finds on the stand-in, whatever the company is called: its lead first, as casting
 * lists them.
 */
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

/**
 * Whether `root` is the folder `founders` names: by name, or, when both are there, as the same
 * folder on disk, which a case-insensitive volume or a link reaches by another name.
 */
const isFolder = (root: string, founders: string): boolean => {
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

/**
 * The save main opens on the stand-in, or null with the switch unset or empty. It refuses a value
 * but 1, which read as off would put main on the developer's own logins unseen; the window's dev
 * server, whose shell starts main on those logins; and the founder's save, whose queued work the
 * stand-in would settle as done with nothing done.
 */
const standInRoot = (mode: string): string | null => {
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
  // as main reads it (launchRoot), from the same working directory
  return path.resolve(root);
};

/** Where claude keeps the managed settings that outrank every other tier of its own. */
const CLAUDE_MANAGED = "/Library/Application Support/ClaudeCode";

/**
 * The runners signed in to the stand-in: claude only on a Mac with no managed settings of its own,
 * whose env or key helper outrank the stand-in's sign-in and could send a run to a real provider,
 * as the e2e suite skips there too.
 */
const standInRunners = (): readonly RunnerId[] =>
  ["managed-settings.json", "managed-settings.d"].some((name) =>
    existsSync(path.join(CLAUDE_MANAGED, name)),
  )
    ? RUNNER_IDS.filter((runner) => runner !== "claude")
    : RUNNER_IDS;

interface StandIn {
  /** Main on `root`, its runners signed in to the stand-in and none of the terminal's logins. */
  main: Pick<DevHostOptions, "env" | "inherit" | "root">;
  close: () => Promise<void>;
}

/**
 * The stand-in model, casting STAND_IN_TEAM for any company and ending every run on "done", and the
 * CLIs the adapters bundle signed in to it, as each e2e launch has them (tools/e2e/src/harness.ts).
 * A run ending at once spins nothing: the lead's next proposal waits on news or 15 minutes.
 */
const startStandIn = async (
  ssr: RunnableDevEnvironment,
  root: string,
  log: (line: string) => void,
): Promise<StandIn> => {
  const { startStandInModel } =
    await ssr.runner.import<typeof StandInModelModule>("idlebiz/stand-in-model");
  const { isProviderEnv, standInRunnerEnv } = await ssr.runner.import<typeof StandInRunnersModule>(
    "idlebiz/stand-in-runners",
  );
  // outside the save, which a run's seal closes to it, and gone with this server however it ends:
  // vite exits on a TERM without waiting on `close`, and a Ctrl-C ends it with no exit event, so
  // the interrupt clears it first, then takes its course
  const scratch = await mkdtemp(path.join(tmpdir(), "idlebiz-stand-in-"));
  const clear = (): void => {
    rmSync(scratch, { force: true, recursive: true });
  };
  const interrupted = (): void => {
    clear();
    process.kill(process.pid, "SIGINT");
  };
  process.once("exit", clear);
  process.once("SIGINT", interrupted);
  let model: StandInModel | null = null;
  const close = async (): Promise<void> => {
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
        // the terminal's own logins stay out, so a run reaches the stand-in or nothing
        inherit: (name) => name !== STAND_IN_SWITCH && !isProviderEnv(name),
        root,
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
};

const devServer = (mode: string): Plugin => ({
  apply: "serve",
  configureServer: async (server: ViteDevServer) => {
    // refused before anything starts
    const standInSave = standInRoot(mode);
    let host: DevHost | null = null;
    let standIn: StandIn | null = null;
    const watching = await watchServer(() => {
      const running = host;
      if (running === null) {
        return;
      }
      server.config.logger.info("[host] main changed: restarting it");
      // a main that fails to boot is said, and the next edit tries again
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
          server.config.logger.error(`[host] could not stop: ${errorMessage(hostStopped.reason)}`);
        }
        // once main has stopped its runs, which may still be asking it
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
    // loaded through the dev server's own runner, which resolves the app's imports as the app does
    const { ssr } = server.environments;
    if (!isRunnableDevEnvironment(ssr)) {
      throw new Error("the dev server cannot run the dev host");
    }
    const { startDevHost } = await ssr.runner.import<typeof DevHostModule>("idlebiz/dev-host");
    const log = (line: string): void => {
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
      // a main that never booted leaves no stand-in behind it
      await standing?.close();
      throw error;
    }
    host = started;
    standIn = standing;
    // `/` here is the way into main's page: each visit a fresh link from the main running now, so the
    // one address outlives a restart of main, whose page is on a port of its own. Main asks for the
    // page by name (`/index.html`), so this answers browsers alone
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
});

export default defineConfig(({ mode }) => ({
  build: {
    emptyOutDir: true,
    outDir: path.resolve(configDir, "dist"),
    // the system WebKit at the macOS floor (MINIMUM_MACOS in scripts/package.ts), the one
    // tsconfig.page.json caps the stdlib to, and the CSS's target too: Vite's own default moves with
    // each major
    target: "safari16.6",
  },
  clearScreen: false,
  plugins: [tailwindcss(), react(), devContentSecurityPolicy(), devServer(mode)],
  publicDir: path.resolve(configDir, "public"),
  resolve: { tsconfigPaths: true },
  root: path.resolve(configDir, "src/renderer"),
  server: {
    // the page's files reach the page through the server, but its hot-reload socket dials here
    hmr: { clientPort: DEV_PORT, host: "localhost" },
    port: DEV_PORT,
    strictPort: true,
  },
}));
