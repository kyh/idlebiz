import { expect, it } from "vitest";
import type { AuthFlowEvent } from "@/shared/domain";
import { nextAttempt } from "./use-auth-flow";
import type { Attempt } from "./use-auth-flow";

const replay = (events: AuthFlowEvent[]): Attempt => {
  let attempt: Attempt = { lines: [], phase: "logging-in" };
  for (const e of events) {
    attempt = nextAttempt(attempt, e);
  }
  return attempt;
};

it("keeps a signed-out runner's terminal command when another runner makes the sign-in done", () => {
  const instruction = "Couldn't finish automatically. In a terminal, run: codex login";
  const auth = replay([
    { message: "Signing in to Codex — your browser will open…", type: "progress" },
    { message: instruction, type: "progress" },
    { message: "Workforce ready: Claude Code.", type: "progress" },
    { type: "done" },
  ]);
  expect(auth).toEqual({
    lines: [
      "Signing in to Codex — your browser will open…",
      instruction,
      "Workforce ready: Claude Code.",
    ],
    phase: "signed-in",
  });
});

it("keeps the last four lines of a long attempt", () => {
  const auth = replay(
    ["a", "b", "c", "d", "e"].map((message): AuthFlowEvent => ({ message, type: "progress" })),
  );
  expect(auth).toEqual({ lines: ["b", "c", "d", "e"], phase: "logging-in" });
});
