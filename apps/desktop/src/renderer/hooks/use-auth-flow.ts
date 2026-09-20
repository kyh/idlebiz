import { useEffect, useEffectEvent, useState } from "react";
import { bridge } from "@/renderer/bridge";
import type { AuthFlowEvent } from "@/shared/domain";

export type Auth =
  | { phase: "checking" }
  | { phase: "signed-out" }
  | { phase: "logging-in"; lines: readonly string[] }
  | { phase: "login-failed"; lines: readonly string[] }
  | { phase: "signed-in"; lines: readonly string[] };

export const linesOf = (a: Auth): readonly string[] => ("lines" in a ? a.lines : []);
const withLine = (a: Auth, line: string): readonly string[] => [...linesOf(a).slice(-3), line];

/** Probe an existing CLI login, or start signed out when the caller already checked. */
export const useAuthFlow = ({ probe, onSignedIn }: { probe: boolean; onSignedIn?: () => void }) => {
  const [auth, setAuth] = useState<Auth>(probe ? { phase: "checking" } : { phase: "signed-out" });
  const signedIn = useEffectEvent(() => onSignedIn?.());

  useEffect(() => {
    if (!probe) {
      return;
    }
    const check = async () => {
      const r = await bridge().hasAuth();
      setAuth(r.ok ? { lines: [], phase: "signed-in" } : { phase: "signed-out" });
    };
    void check();
  }, [probe]);

  useEffect(
    () =>
      bridge().onAuthEvent((e: AuthFlowEvent) => {
        switch (e.type) {
          case "url": {
            setAuth((a) => ({
              lines: withLine(a, "Your browser opened — authorize there, then come back."),
              phase: "logging-in",
            }));
            break;
          }
          case "progress": {
            setAuth((a) => ({ lines: withLine(a, e.message), phase: "logging-in" }));
            break;
          }
          case "done": {
            setAuth((a) => ({ lines: withLine(a, "Connected ✓"), phase: "signed-in" }));
            signedIn();
            break;
          }
          case "error": {
            setAuth((a) => ({ lines: withLine(a, `Hmm — ${e.message}`), phase: "login-failed" }));
            break;
          }
          // no default
        }
      }),
    [],
  );

  const login = () => {
    setAuth({ lines: [], phase: "logging-in" });
    void bridge().startLogin();
  };
  return { auth, login };
};
