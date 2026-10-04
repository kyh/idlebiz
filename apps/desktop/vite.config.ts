// Two outputs from one config. The page (`vite build`, and the dev server): React and Phaser, which
// main serves the shell's window on its own origin (src/main/page-server.ts). Main
// (`vite build --mode main`): one node bundle the shell runs on the node it ships. Main bundles its
// dependencies, but for sharp, which is native and loads from node_modules, and the ACP adapters,
// which it never imports: it resolves them there and runs each as its own process.
//
// The dev server answers the page's files to main, which hands them on, so the page keeps main's
// origin and still reloads in place; its hot-reload socket dials this server directly. It builds
// main too, before it serves and again on each change: `tauri dev` restarts the shell when main
// changes, and `--mode browser` runs main itself, as the shell does (src/dev-host/host.ts), with
// `/` here the way into main's page.

import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, defineConfig, isRunnableDevEnvironment } from "vite";
import type { Plugin, ViteDevServer } from "vite";
import type * as DevHostModule from "./src/dev-host/host.ts";
import type { DevHost } from "./src/dev-host/host.ts";
import { errorMessage } from "./src/shared/errors.ts";
import { pagePolicy } from "./src/shared/page-policy.ts";
import { DEV_PORT } from "./src/shared/page-routes.ts";

const configDir = import.meta.dirname;
const alias = { "@": path.resolve(configDir, "src") };

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

/** Builds main, resolving once the first build is out; each later one calls `rebuilt`. */
const watchMain = async (rebuilt: () => void): Promise<Watching> => {
  const watcher = await build({
    build: { watch: {} },
    configFile: path.resolve(configDir, "vite.config.ts"),
    mode: "main",
  });
  if (!("on" in watcher)) {
    throw new Error("main's watch build answered with no watcher");
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

const devMain = (mode: string): Plugin => ({
  apply: "serve",
  configureServer: async (server: ViteDevServer) => {
    let host: DevHost | null = null;
    const watching = await watchMain(() => {
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
      void watching.close();
      void host?.stop();
    });
    if (mode !== "browser") {
      return;
    }
    // loaded through the dev server's own runner, which resolves the app's imports as the app does
    const { ssr } = server.environments;
    if (!isRunnableDevEnvironment(ssr)) {
      throw new Error("the dev server cannot run the dev host");
    }
    const { startDevHost } = await ssr.runner.import<typeof DevHostModule>(
      path.resolve(configDir, "src/dev-host/host.ts"),
    );
    const started = await startDevHost({
      log: (line) => {
        server.config.logger.info(line);
      },
      pageDevUrl: `http://localhost:${DEV_PORT}`,
    });
    host = started;
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
  name: "idlebiz-dev-main",
});

export default defineConfig(({ mode }) =>
  mode === "main"
    ? {
        build: {
          emptyOutDir: true,
          outDir: path.resolve(configDir, ".output/main"),
          rolldownOptions: {
            external: ["sharp"],
            output: { entryFileNames: "index.js" },
          },
          ssr: path.resolve(configDir, "src/main/index.ts"),
          target: "node24",
        },
        // the page's files are the page's
        publicDir: false,
        resolve: { alias },
        ssr: { noExternal: true },
      }
    : {
        build: {
          emptyOutDir: true,
          outDir: path.resolve(configDir, ".output/renderer"),
        },
        clearScreen: false,
        plugins: [tailwindcss(), react(), devContentSecurityPolicy(), devMain(mode)],
        publicDir: path.resolve(configDir, "public"),
        resolve: { alias },
        root: path.resolve(configDir, "src/renderer"),
        server: {
          // the page's files reach the page through main, but its hot-reload socket dials here
          hmr: { clientPort: DEV_PORT, host: "localhost" },
          port: DEV_PORT,
          strictPort: true,
        },
      },
);
