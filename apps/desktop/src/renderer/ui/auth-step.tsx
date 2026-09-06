import { linesOf, type Auth } from "@/renderer/hooks/use-auth-flow";

/** The login flow's transcript and its one button, wherever the flow is shown. */
export function AuthStep({
  auth,
  onLogin,
  aside,
}: {
  auth: Auth;
  onLogin: () => void;
  /** Sits at the left of the button row. */
  aside?: React.ReactNode;
}) {
  const lines = linesOf(auth);
  return (
    <div className="flex w-full flex-col gap-2">
      {lines.length > 0 ? (
        <div className="px-inset max-h-20 overflow-y-auto whitespace-pre-line p-2 text-xs text-fg-dim">
          {lines.join("\n")}
        </div>
      ) : null}
      <div className="flex items-center">
        {aside}
        <button
          type="button"
          onClick={onLogin}
          disabled={auth.phase === "logging-in"}
          className="px-btn-accent px-btn ml-auto"
        >
          {auth.phase === "logging-in"
            ? "Setting up…"
            : auth.phase === "login-failed"
              ? "Try again"
              : "Set up workforce"}
        </button>
      </div>
    </div>
  );
}
