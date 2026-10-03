import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    globalSetup: ["src/main/vitest-global-setup.ts"],
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["src/main/vitest-setup.ts"],
  },
});
