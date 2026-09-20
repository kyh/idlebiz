import type { Submission } from "@/renderer/hooks/use-submission";

/** Why the founder's last action did not go through, beside the control that tried it. */
export const Failure = ({ submission, doing }: { submission: Submission; doing?: string }) =>
  submission.kind === "failed" ? (
    <div role="alert" className="mt-1 text-xs text-danger">
      {doing ? `Could not ${doing}: ` : ""}
      {submission.message}
    </div>
  ) : null;
