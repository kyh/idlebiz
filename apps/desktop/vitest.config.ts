import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests for the pure parts: seating, poses, the layout schema, the walk
// grid, the command policy, the store over a throwaway home. No Electron, no
// Phaser — anything that needs a window is verified live over CDP instead
// (see AGENTS.md).
export default defineConfig({
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "src") },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
