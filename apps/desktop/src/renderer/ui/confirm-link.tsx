import { useState } from "react";
import { useSubmission } from "@/renderer/hooks/use-submission";
import { Failure } from "@/renderer/ui/failure";
import { cn } from "cn";

/** A destructive link that asks twice: what it does cannot be undone from the UI. */
export const ConfirmLink = ({
  label,
  confirmLabel,
  title,
  className,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  title?: string;
  className?: string;
  onConfirm: () => Promise<void>;
}) => {
  const [arming, setArming] = useState(false);
  const { submission, submit } = useSubmission(onConfirm);
  if (!arming) {
    return (
      <button
        type="button"
        onClick={() => setArming(true)}
        className={cn("px-link px-link-danger", className)}
        title={title}
      >
        {label}
      </button>
    );
  }
  return (
    <span className={cn("flex flex-col items-end", className)}>
      <span className="flex items-baseline gap-2">
        <button type="button" onClick={() => setArming(false)} className="px-link">
          keep
        </button>
        <button
          type="button"
          onClick={() => submit()}
          disabled={submission.kind === "sending"}
          className="px-link px-link-danger"
        >
          {confirmLabel}
        </button>
      </span>
      <Failure submission={submission} />
    </span>
  );
};
