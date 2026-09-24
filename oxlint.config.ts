import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";

export default defineConfig({
  extends: [core, react, antiSlop],
  ignorePatterns: [...(core.ignorePatterns ?? []), "dist-electron", ".claude", "*.tsbuildinfo"],
  options: { typeAware: true },
  overrides: [
    { files: ["apps/web/**"], plugins: next.plugins, rules: next.rules },
    {
      // Untyped .mjs/.cjs scripts reading JSON and pixel data: there is no type to check.
      files: ["apps/desktop/scripts/**"],
      rules: {
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
      },
    },
  ],
  rules: {
    // Sequential awaits in loops are deliberate here (ordered agent turns, paced writes).
    "no-await-in-loop": "off",
    // A bare `return` in a `T | undefined` helper is deliberate.
    "typescript/consistent-return": "off",
    // `() => set(x)` is the house style for handlers.
    "typescript/no-confusing-void-expression": "off",
    // A promise-returning function need not be `async`; a dropped promise is no-floating-promises' job.
    "typescript/promise-function-async": "off",
    // Truthiness checks on optionals are idiomatic here.
    "typescript/strict-boolean-expressions": "off",
    // A value handed where void is expected is harmless; a promise there is no-misused-promises' job.
    "typescript/strict-void-return": "off",
    // A `default` is how a consumer says every other kind means nothing to it.
    "typescript/switch-exhaustiveness-check": [
      "error",
      { considerDefaultExhaustiveForUnions: true },
    ],
  },
});
