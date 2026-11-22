import path from "node:path";
import { defineConfig } from "vite";

const configDir = import.meta.dirname;

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: path.resolve(configDir, "dist"),
    rolldownOptions: {
      output: { chunkFileNames: "[name]-[hash].js", entryFileNames: "index.js" },
    },
    ssr: path.resolve(configDir, "src/index.ts"),
    target: "node24",
  },
  publicDir: false,
  ssr: { noExternal: true },
});
