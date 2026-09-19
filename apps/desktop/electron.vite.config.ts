import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const configDir = import.meta.dirname;

export default defineConfig({
  main: {
    build: {
      // bundle the workspace packages' source (raw .ts — must be inlined)
      externalizeDeps: { exclude: ["@repo/agent-driver", "@repo/stripe-connect-protocol"] },
      outDir: ".output/app/main",
      rollupOptions: {
        // sharp is native: keep it external so it loads from node_modules at runtime
        external: ["electron", "sharp"],
        input: { index: path.resolve(configDir, "src/main/index.ts") },
      },
    },
    resolve: {
      alias: { "@": path.resolve(configDir, "src") },
    },
  },
  preload: {
    build: {
      lib: {
        entry: path.resolve(configDir, "src/preload/index.ts"),
        formats: ["cjs"],
      },
      outDir: ".output/app/preload",
      rollupOptions: {
        external: ["electron"],
        output: { entryFileNames: "index.js" },
      },
    },
    resolve: {
      alias: { "@": path.resolve(configDir, "src") },
    },
  },
  renderer: {
    build: {
      outDir: ".output/app/renderer",
      rollupOptions: {
        input: { index: path.resolve(configDir, "src/renderer/index.html") },
      },
    },
    plugins: [tailwindcss(), react()],
    publicDir: path.resolve(configDir, "public"),
    resolve: {
      alias: { "@": path.resolve(configDir, "src") },
    },
  },
});
