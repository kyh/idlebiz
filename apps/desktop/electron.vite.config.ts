import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const configDir = import.meta.dirname;

export default defineConfig({
  main: {
    build: {
      outDir: ".output/app/main",
      rolldownOptions: {
        // On Vite 8, electron-vite's own externals (electron, `dependencies`) never
        // apply, so main bundles whatever is not named here: electron would become
        // its npm path stub, and sharp is native and must load from node_modules.
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
      rolldownOptions: {
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
      rolldownOptions: {
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
