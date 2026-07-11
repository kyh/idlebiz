import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { LibraryFormats } from "vite";

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig(() => ({
  main: {
    resolve: {
      alias: { "@": resolve(configDir, "src") },
    },
    build: {
      outDir: ".output/app/main",
      // bundle the workspace agent-driver source (raw .ts — must be inlined)
      externalizeDeps: { exclude: ["@repo/agent-driver"] },
      rollupOptions: {
        // sharp is native: keep it external so it loads from node_modules at runtime
        external: ["electron", "sharp"],
        input: { index: resolve(configDir, "src/main/index.ts") },
      },
    },
  },
  preload: {
    resolve: {
      alias: { "@": resolve(configDir, "src") },
    },
    build: {
      outDir: ".output/app/preload",
      lib: {
        entry: resolve(configDir, "src/preload/index.ts"),
        formats: ["cjs"] satisfies LibraryFormats[],
      },
      rollupOptions: {
        external: ["electron"],
        output: { entryFileNames: "index.js" },
      },
    },
  },
  renderer: {
    plugins: [tailwindcss(), react()],
    publicDir: resolve(configDir, "public"),
    resolve: {
      alias: { "@": resolve(configDir, "src") },
    },
    build: {
      outDir: ".output/app/renderer",
      rollupOptions: {
        input: { index: resolve(configDir, "src/renderer/index.html") },
      },
    },
  },
}));
