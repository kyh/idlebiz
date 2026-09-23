import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useSubmission } from "@/renderer/hooks/use-submission";
import { refresh } from "@/renderer/state/store";
import { Curtain } from "@/renderer/ui/curtain";

// Not onboarding: a company main failed to report may still be on disk, and a
// fresh start would stack a second one on it.
export const Unreachable = ({ message }: { message: string }) => {
  const { submission, submit } = useSubmission(refresh);
  const retrying = submission.kind === "sending";
  return (
    <Curtain>
      <AlertDialog.Title className="text-base text-fg">
        The office didn&apos;t load
      </AlertDialog.Title>
      <AlertDialog.Description className="mt-1 text-sm leading-relaxed text-fg-dim">
        IdleBiz asked for your company and got an error back. Try again; if it keeps failing,
        relaunch.
      </AlertDialog.Description>
      <div className="px-inset mt-2 p-2 text-xs text-fg-dim">{message}</div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => submit()}
          disabled={retrying}
          className="px-btn-accent px-btn"
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </div>
    </Curtain>
  );
};
