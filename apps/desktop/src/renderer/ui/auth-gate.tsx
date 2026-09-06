import { useAuthFlow } from "@/renderer/hooks/use-auth-flow";
import { setAuthed } from "@/renderer/state/store";
import { AuthStep } from "@/renderer/ui/auth-step";
import { Curtain } from "@/renderer/ui/curtain";

export function AuthGate() {
  const { auth, login } = useAuthFlow({ probe: false, onSignedIn: () => setAuthed(true) });
  return (
    <Curtain>
      <div className="mb-3 text-sm leading-relaxed text-fg">
        Your team can't work — no signed-in coding CLI (Claude Code or Codex) was found. Set one up
        to get the office moving again.
      </div>
      <AuthStep auth={auth} onLogin={login} />
    </Curtain>
  );
}
