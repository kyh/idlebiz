import { useEffect, useEffectEvent, useState } from "react";
import { api, listen } from "@/renderer/api";
import { useStore } from "@/renderer/state/store";
import type { AuthFlowEvent } from "@repo/domain/domain";

export type Auth =
  | { phase: "checking" }
  | { phase: "signed-out" }
  | { phase: "logging-in"; lines: readonly string[] }
  | { phase: "login-failed"; lines: readonly string[] }
  | { phase: "signed-in"; lines: readonly string[] };

export type Attempt = Extract<Auth, { lines: readonly string[] }>;

export const linesOf = (a: Auth): readonly string[] => ("lines" in a ? a.lines : []);
const withLine = (attempt: Attempt | null, line: string): readonly string[] => [
  ...(attempt?.lines ?? []).slice(-3),
  line,
];

const probed = (authed: boolean | null): Auth => {
  if (authed === null) {
    return { phase: "checking" };
  }
  return authed ? { lines: [], phase: "signed-in" } : { phase: "signed-out" };
};

/**
 * A login's progress after one event. Done adds no line: another runner may be what signed in
 * while the one the founder is signing in to failed, and its last line says how to finish it.
 */
export const nextAttempt = (attempt: Attempt | null, e: AuthFlowEvent): Attempt => {
  switch (e.type) {
    case "url": {
      return {
        lines: withLine(attempt, "Your browser opened — authorize there, then come back."),
        phase: "logging-in",
      };
    }
    case "progress": {
      return { lines: withLine(attempt, e.message), phase: "logging-in" };
    }
    case "done": {
      return { lines: attempt?.lines ?? [], phase: "signed-in" };
    }
    case "error": {
      return { lines: withLine(attempt, `Hmm — ${e.message}`), phase: "login-failed" };
    }
    // no default
  }
};

/** The store's CLI probe until a login starts here, then that login's progress. */
export const useAuthFlow = (onSignedIn?: () => void) => {
  const authed = useStore((s) => s.authed);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const signedIn = useEffectEvent(() => onSignedIn?.());

  useEffect(
    () =>
      listen("auth", (e: AuthFlowEvent) => {
        setAttempt((a) => nextAttempt(a, e));
        if (e.type === "done") {
          signedIn();
        }
      }),
    [],
  );

  const login = () => {
    setAttempt({ lines: [], phase: "logging-in" });
    void api().agents.startLogin();
  };
  return { auth: attempt ?? probed(authed), login };
};
