import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import landmines from "ultracite/oxlint/landmines";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";

export default defineConfig({
  extends: [core, react, antiSlop, landmines],
  ignorePatterns: [...(core.ignorePatterns ?? []), "target", ".claude", "*.tsbuildinfo"],
  jsPlugins: landmines.jsPlugins,
  options: { typeAware: true },
  overrides: [
    { files: ["apps/web/**"], plugins: next.plugins, rules: next.rules },
    {
      files: [
        "apps/desktop/src/renderer/report-fault.test.ts",
        "apps/desktop/src/renderer/state/store.test.ts",
      ],
      rules: { "landmines-testing/no-test-doubles": "off" },
    },
  ],
  rules: {
    "anti-slop/require-safety-comment-for-type-assertion": "off",
    "landmines-testing/no-fixed-sleep": [
      "error",
      { allow: { "packages/sandbox/src/machine.mac.test.ts": 3 } },
    ],
    "landmines-testing/no-flake-masking": [
      "error",
      {
        allow: {
          "apps/cli/src/server/agents/browser-gate.test.ts": 2,
          "apps/cli/src/server/agents/claude-gate.test.ts": 14,
          "apps/cli/src/server/agents/codex-gate.test.ts": 9,
          "apps/cli/src/server/agents/sandbox.mac.test.ts": 1,
          "apps/cli/src/server/test-support/stand-in-runners.test.ts": 2,
          "packages/sandbox/src/machine.mac.test.ts": 2,
        },
      },
    ],
    "landmines-testing/strict-msw": [
      "error",
      { allow: { "apps/cli/src/server/test-support/network.ts": 1 } },
    ],
    "no-await-in-loop": "off",
    "typescript/consistent-return": "off",
    "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    "typescript/no-confusing-void-expression": "off",
    "typescript/promise-function-async": "off",
    "typescript/strict-boolean-expressions": "off",
    "typescript/strict-void-return": "off",
    "typescript/switch-exhaustiveness-check": [
      "error",
      { considerDefaultExhaustiveForUnions: true },
    ],
  },
});
