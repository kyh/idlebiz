import { useSubmission } from "@/renderer/hooks/use-submission";
import type { Submission } from "@/renderer/hooks/use-submission";
import { resolveApproval } from "@/renderer/state/store";

interface Approval {
  submission: Submission;
  /** True from the click on, so a card never offers a second answer. */
  decided: boolean;
  decide: (approved: boolean) => void;
}

/** The founder's answer to one held command, wherever its card is shown. */
export const useApproval = (taskId: string): Approval => {
  const { submission, submit } = useSubmission((approved: boolean) =>
    resolveApproval(taskId, approved),
  );
  return {
    decide: submit,
    decided: submission.kind === "sending" || submission.kind === "sent",
    submission,
  };
};

export const ApprovalButtons = ({ decided, decide }: Omit<Approval, "submission">) => (
  <span className="flex gap-2">
    <button type="button" onClick={() => decide(false)} disabled={decided} className="px-btn">
      Deny
    </button>
    <button
      type="button"
      onClick={() => decide(true)}
      disabled={decided}
      className="px-btn-accent px-btn"
    >
      Approve
    </button>
  </span>
);
