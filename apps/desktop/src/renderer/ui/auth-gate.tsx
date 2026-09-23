import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useAuthFlow } from "@/renderer/hooks/use-auth-flow";
import { setAuthed } from "@/renderer/state/store";
import { AuthStep } from "@/renderer/ui/auth-step";
import { Curtain } from "@/renderer/ui/curtain";

export const AuthGate = () => {
  const { auth, login } = useAuthFlow({ onSignedIn: () => setAuthed(true), probe: false });
  return (
    <Curtain>
      <AlertDialog.Title className="mb-3 text-sm leading-relaxed text-fg">
        Your team can&apos;t work — no signed-in coding CLI (Claude Code or Codex) was found. Set
        one up to get the office moving again.
      </AlertDialog.Title>
      <AuthStep auth={auth} onLogin={login} />
    </Curtain>
  );
};
