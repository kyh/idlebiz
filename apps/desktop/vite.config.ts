// Two outputs from one config. The page (`vite build`, and the dev server): React and Phaser, which
// the shell's window loads as the bundle's own and the dev host serves to a browser. Main
// (`vite build --mode main`): one node bundle the shell runs on the node it ships. Main bundles its
// dependencies, but for sharp, which is native and loads from node_modules, and the ACP adapters,
// which it never imports: it resolves them there and runs each as its own process.
//
// The dev server builds main too, before it serves the page and again on each change: `tauri dev`
// restarts the shell when main changes, and `--mode browser` runs main itself, behind the dev
// host's bridge on the page's own origin (src/dev-host/host.ts).

import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, defineConfig, isRunnableDevEnvironment } from "vite";
import type { Plugin, ViteDevServer } from "vite";
import type * as DevHostModule from "./src/dev-host/host.ts";
import type { DevHost } from "./src/dev-host/host.ts";
import { pagePolicy } from "./src/dev-host/policy.ts";
import { DEV_PORT } from "./src/shared/dev-bridge.ts";

const configDir = import.meta.dirname;
const alias = { "@": path.resolve(configDir, "src") };

// A page the dev server serves gets no policy from Tauri, so the dev server writes the shell's into
// it, opened to its own socket, which hot reload rides. At the end of the head: a meta policy
// covers only what follows it, and the dev server's own preamble for React's refresh is inline.
const devContentSecurityPolicy = (): Plugin => ({
  apply: "serve",
  name: "idlebiz-dev-content-security-policy",
  transformIndexHtml: () => [
    {
      attrs: {
        content: pagePolicy({ connect: ["ws://localhost:*"], desktopDir: configDir, meta: true }),
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
  await firstBuild;
  return { close: async () => await watcher.close() };
};

const devMain = (mode: string): Plugin => ({
  apply: "serve",
  configureServer: async (server: ViteDevServer) => {
    let host: DevHost | null = null;
    const watching = await watchMain(() => {
      if (host !== null) {
        server.config.logger.info("[host] main changed: restarting it");
        void host.restartMain();
      }
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
    host = await startDevHost({
      log: (line) => {
        server.config.logger.info(line);
      },
    });
    server.middlewares.use(host.middleware);
    const { fragment } = host;
    server.httpServer?.once("listening", () => {
      server.config.logger.info(
        `\n  IdleBiz in a browser: http://localhost:${DEV_PORT}/#${fragment}\n`,
      );
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
        server: { port: DEV_PORT, strictPort: true },
      },
);
