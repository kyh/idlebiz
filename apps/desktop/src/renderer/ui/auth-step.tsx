import { api } from "@/renderer/api";
import { linesOf } from "@/renderer/hooks/use-auth-flow";
import type { Auth } from "@/renderer/hooks/use-auth-flow";
import { useSubmission } from "@/renderer/hooks/use-submission";
import { Failure } from "@/renderer/ui/failure";

const loginLabel = (phase: Auth["phase"]): string => {
  if (phase === "logging-in") {
    return "Setting up…";
  }
  if (phase === "login-failed") {
    return "Try again";
  }
  return "Set up workforce";
};

/** Stops the setup under way: main ends it with an `auth` error, which moves the step on. */
export const CancelLogin = () => {
  const { submission, submit } = useSubmission(async () => {
    await api.agents.cancelLogin();
  });
  return (
    <span className="flex flex-col items-end">
      <button
        type="button"
        onClick={() => submit()}
        disabled={submission.kind === "sending"}
        className="px-link"
      >
        cancel
      </button>
      <Failure submission={submission} doing="cancel" />
    </span>
  );
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
  const attempt = linesOf(auth);
  // the onboarding's sign-in is done once any runner is ready, so here done means connected
  const lines =
    auth.phase === "signed-in" && attempt.length > 0 ? [...attempt, "Connected ✓"] : attempt;
  return (
    <div className="flex w-full flex-col gap-2">
      {lines.length > 0 ? (
        <div className="px-inset max-h-20 overflow-y-auto whitespace-pre-line p-2 text-xs text-fg-dim">
          {lines.join("\n")}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-3">
        {aside}
        {auth.phase === "logging-in" ? <CancelLogin /> : null}
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
