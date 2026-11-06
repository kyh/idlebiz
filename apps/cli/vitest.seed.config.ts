import { defineConfig } from "vitest/config";

// The update smoke's seed alone (src/server/test-support/seed-save.seed.ts), which the smoke runs
// on a save of its own in scratch. vitest.config.ts includes *.test.ts alone, so `pnpm test` never
// runs it, and nothing here can skip unseen: with no save named it fails.
export default defineConfig({
  test: {
    include: ["src/server/test-support/seed-save.seed.ts"],
  },
});
