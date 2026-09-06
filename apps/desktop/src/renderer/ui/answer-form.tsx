import { useEffect, useRef, useState } from "react";
import { answerQuestion } from "@/renderer/state/store";
import type { Task } from "@/shared/domain";
import { errorMessage } from "@/shared/errors";

type Submission =
  | { kind: "ready" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "failed"; message: string };

export function AnswerForm({
  task,
  autoFocus = false,
  onSent,
}: {
  task: Task;
  autoFocus?: boolean;
  onSent?: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [submission, setSubmission] = useState<Submission>({ kind: "ready" });
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const disabled = submission.kind === "sending" || submission.kind === "sent";

  const send = async () => {
    const text = answer.trim();
    if (!text || disabled) return;
    setSubmission({ kind: "sending" });
    try {
      await answerQuestion(task.id, text);
      if (!mounted.current) return;
      setSubmission({ kind: "sent" });
      onSent?.();
    } catch (cause) {
      if (mounted.current) setSubmission({ kind: "failed", message: errorMessage(cause) });
    }
  };

  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Your answer…"
          className="px-field min-w-0 flex-1"
          disabled={disabled}
          autoFocus={autoFocus}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!answer.trim() || disabled}
          className="px-btn-accent px-btn"
        >
          {submission.kind === "sent"
            ? "Sent ✓"
            : submission.kind === "sending"
              ? "Sending…"
              : "Answer"}
        </button>
      </div>
      {submission.kind === "failed" ? (
        <div role="alert" className="mt-1 text-xs text-danger">
          Could not answer: {submission.message}
        </div>
      ) : null}
    </div>
  );
}
