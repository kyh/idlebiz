import { useSubmission } from "@/renderer/hooks/use-submission";
import type { Submission } from "@/renderer/hooks/use-submission";
import { api } from "@/renderer/api";

interface Approval {
  submission: Submission;
  /** True from the click on, so a card never offers a second answer. */
  decided: boolean;
  decide: (approved: boolean) => void;
}

/** The founder's answer to one held command, wherever its card is shown: the task resumes
 *  either way. */
export const useApproval = (taskId: string): Approval => {
  const { submission, submit } = useSubmission(async (approved: boolean) => {
    await api.tasks.resolveApproval({ approved, taskId });
  });
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
