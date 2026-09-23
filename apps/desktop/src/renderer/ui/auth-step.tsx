import { linesOf } from "@/renderer/hooks/use-auth-flow";
import type { Auth } from "@/renderer/hooks/use-auth-flow";

const loginLabel = (phase: Auth["phase"]): string => {
  if (phase === "logging-in") {
    return "Setting up…";
  }
  if (phase === "login-failed") {
    return "Try again";
  }
  return "Set up workforce";
};

export const AuthStep = ({
  auth,
  onLogin,
  aside,
}: {
  auth: Auth;
  onLogin: () => void;
  aside?: React.ReactNode;
}) => {
  const lines = linesOf(auth);
  return (
    <div className="flex w-full flex-col gap-2">
      {lines.length > 0 ? (
        <div className="px-inset max-h-20 overflow-y-auto whitespace-pre-line p-2 text-xs text-fg-dim">
          {lines.join("\n")}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-3">
        {aside}
        <button
          type="button"
          onClick={onLogin}
          disabled={auth.phase === "logging-in"}
          className="px-btn-accent px-btn"
        >
          {loginLabel(auth.phase)}
        </button>
      </div>
    </div>
  );
};
