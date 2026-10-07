// The server and its command in one node bundle (`dist/index.js`), which the desktop shell runs on
// the node it ships (`idlebiz serve`). It bundles its dependencies but for sharp, which is native and
// loads from node_modules, and the ACP adapters, which it never imports: it resolves them there and
// runs each as its own process. Chunks land flat beside the entry, which `src/paths.ts` counts on.
// The page the server hands the window is the desktop's build, staged as `dist/page` once this one
// is out (`scripts/stage-page.ts`).

import path from "node:path";
import { defineConfig } from "vite";

const configDir = import.meta.dirname;

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: path.resolve(configDir, "dist"),
    rolldownOptions: {
      external: ["sharp"],
      output: { chunkFileNames: "[name]-[hash].js", entryFileNames: "index.js" },
    },
    ssr: path.resolve(configDir, "src/index.ts"),
    target: "node24",
  },
  publicDir: false,
  ssr: { noExternal: true },
});
