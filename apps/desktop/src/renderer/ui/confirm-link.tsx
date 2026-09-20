import { useState } from "react";
import { errorMessage } from "@/shared/errors";
import { cn } from "cn";

/** A destructive link that asks twice: what it does cannot be undone from the UI. */
export const ConfirmLink = ({
  label,
  confirmLabel,
  title,
  className,
  onConfirm,
  onNote,
}: {
  label: string;
  confirmLabel: string;
  title?: string;
  className?: string;
  onConfirm: () => Promise<void>;
  onNote: (note: string) => void;
}) => {
  const [arming, setArming] = useState(false);
  const confirm = async () => {
    try {
      await onConfirm();
    } catch (error) {
      onNote(errorMessage(error));
    }
  };
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
    <span className={cn("flex items-baseline gap-2", className)}>
      <button type="button" onClick={() => setArming(false)} className="px-link">
        keep
      </button>
      <button
        type="button"
        onClick={() => {
          void confirm();
        }}
        className="px-link px-link-danger"
      >
        {confirmLabel}
      </button>
    </span>
  );
};
