import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/server/test-support/seed-save.seed.ts"],
  },
});
