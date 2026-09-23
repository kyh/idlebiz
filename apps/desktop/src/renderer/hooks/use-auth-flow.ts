import { useEffect, useEffectEvent, useState } from "react";
import { bridge } from "@/renderer/bridge";
import { useStore } from "@/renderer/state/store";
import type { AuthFlowEvent } from "@/shared/domain";

export type Auth =
  | { phase: "checking" }
  | { phase: "signed-out" }
  | { phase: "logging-in"; lines: readonly string[] }
  | { phase: "login-failed"; lines: readonly string[] }
  | { phase: "signed-in"; lines: readonly string[] };

type Attempt = Extract<Auth, { lines: readonly string[] }>;

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

/** The store's CLI probe until a login starts here, then that login's progress. */
export const useAuthFlow = (onSignedIn?: () => void) => {
  const authed = useStore((s) => s.authed);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const signedIn = useEffectEvent(() => onSignedIn?.());

  useEffect(
    () =>
      bridge().onAuthEvent((e: AuthFlowEvent) => {
        switch (e.type) {
          case "url": {
            setAttempt((a) => ({
              lines: withLine(a, "Your browser opened — authorize there, then come back."),
              phase: "logging-in",
            }));
            break;
          }
          case "progress": {
            setAttempt((a) => ({ lines: withLine(a, e.message), phase: "logging-in" }));
            break;
          }
          case "done": {
            setAttempt((a) => ({ lines: withLine(a, "Connected ✓"), phase: "signed-in" }));
            signedIn();
            break;
          }
          case "error": {
            setAttempt((a) => ({
              lines: withLine(a, `Hmm — ${e.message}`),
              phase: "login-failed",
            }));
            break;
          }
          // no default
        }
      }),
    [],
  );

  const login = () => {
    setAttempt({ lines: [], phase: "logging-in" });
    void bridge().startLogin();
  };
  return { auth: attempt ?? probed(authed), login };
};
