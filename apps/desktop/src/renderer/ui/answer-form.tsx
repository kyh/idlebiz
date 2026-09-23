import { useState } from "react";
import { useSubmission } from "@/renderer/hooks/use-submission";
import type { Submission } from "@/renderer/hooks/use-submission";
import { answerQuestion } from "@/renderer/state/store";
import { Failure } from "@/renderer/ui/failure";
import type { Task } from "@/shared/domain";

const submitLabel = (submission: Submission): string => {
  if (submission.kind === "sent") {
    return "Sent ✓";
  }
  if (submission.kind === "sending") {
    return "Sending…";
  }
  return "Answer";
};

export const AnswerForm = ({
  task,
  autoFocus = false,
  onSent,
}: {
  task: Task;
  autoFocus?: boolean;
  onSent?: () => void;
}) => {
  const [answer, setAnswer] = useState("");
  const { submission, submit } = useSubmission(async (text: string) => {
    await answerQuestion(task.id, text);
    onSent?.();
  });
  const disabled = submission.kind === "sending" || submission.kind === "sent";

  const send = () => {
    const text = answer.trim();
    if (text && !disabled) {
      submit(text);
    }
  };

  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Your answer…"
          className="px-field min-w-0 flex-1"
          disabled={disabled}
          autoFocus={autoFocus}
        />
        <button
          type="button"
          onClick={() => {
            send();
          }}
          disabled={!answer.trim() || disabled}
          className="px-btn-accent px-btn"
        >
          {submitLabel(submission)}
        </button>
      </div>
      <Failure submission={submission} doing="answer" />
    </div>
  );
};
