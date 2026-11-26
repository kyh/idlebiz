import path from "node:path";
import { defineConfig } from "electron-vite";

const testPackRoot = process.env.IDLEBIZ_TEST_PACK_ROOT ?? null;

if (testPackRoot !== null && !path.isAbsolute(testPackRoot)) {
  throw new Error(`IDLEBIZ_TEST_PACK_ROOT names a save by its absolute path, not ${testPackRoot}`);
}

export default defineConfig({
  main: {
    build: {
      license: { fileName: "shell-packages.md" },
      outDir: ".output/app/shell",
      rolldownOptions: {
        input: { index: path.resolve(import.meta.dirname, "src/shell/index.ts") },
      },
    },
    define: { __IDLEBIZ_TEST_PACK_ROOT__: JSON.stringify(testPackRoot) },
    resolve: { tsconfigPaths: true },
  },
});
