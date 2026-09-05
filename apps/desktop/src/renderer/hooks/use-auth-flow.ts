import { useEffect, useEffectEvent, useState } from "react";
import { bridge } from "@/renderer/bridge";
import type { AuthFlowEvent } from "@/shared/ipc-registry";

/** The coding CLI the workforce runs on, as far as the probe and the login flow know. */
export type Auth =
  | { phase: "checking" }
  | { phase: "signed-out" }
  | { phase: "logging-in"; lines: readonly string[] }
  | { phase: "login-failed"; lines: readonly string[] }
  | { phase: "signed-in"; lines: readonly string[] };

export const linesOf = (a: Auth): readonly string[] => ("lines" in a ? a.lines : []);
/** The last few lines the login flow said, plus this one — the box shows four. */
const withLine = (a: Auth, line: string): readonly string[] => [...linesOf(a).slice(-3), line];

/**
 * The one login flow: main streams AuthFlowEvents while it installs or signs
 * in a CLI, and this folds them into a phase. `probe` asks main whether a CLI
 * is already signed in; a caller shown because there is none starts signed out.
 */
export function useAuthFlow({ probe, onSignedIn }: { probe: boolean; onSignedIn?: () => void }) {
  const [auth, setAuth] = useState<Auth>(probe ? { phase: "checking" } : { phase: "signed-out" });
  const signedIn = useEffectEvent(() => onSignedIn?.());

  useEffect(() => {
    if (!probe) return;
    void bridge()
      .hasAuth()
      .then((r) => setAuth(r.ok ? { phase: "signed-in", lines: [] } : { phase: "signed-out" }));
  }, [probe]);

  useEffect(() => {
    return bridge().onAuthEvent((e: AuthFlowEvent) => {
      switch (e.type) {
        case "url":
          setAuth((a) => ({
            phase: "logging-in",
            lines: withLine(a, "Your browser opened — authorize there, then come back."),
          }));
          return;
        case "progress":
          setAuth((a) => ({ phase: "logging-in", lines: withLine(a, e.message) }));
          return;
        case "done":
          setAuth((a) => ({ phase: "signed-in", lines: withLine(a, "Connected ✓") }));
          signedIn();
          return;
        case "error":
          setAuth((a) => ({ phase: "login-failed", lines: withLine(a, `Hmm — ${e.message}`) }));
          return;
      }
    });
  }, []);

  const login = () => {
    setAuth({ phase: "logging-in", lines: [] });
    void bridge().startLogin();
  };
  return { auth, login };
}
