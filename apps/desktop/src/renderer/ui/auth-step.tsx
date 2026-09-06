import { linesOf, type Auth } from "@/renderer/hooks/use-auth-flow";
export function AuthStep({
  auth,
  onLogin,
  aside,
}: {
  auth: Auth;
  onLogin: () => void;
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
