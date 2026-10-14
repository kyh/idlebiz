import { useState } from "react";
import { useSubmission } from "@/renderer/hooks/use-submission";
import type { Submission } from "@/renderer/hooks/use-submission";
import { api } from "@/renderer/api";
import { Failure } from "@/renderer/ui/failure";
import type { Task } from "@repo/domain/domain";

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
    await api.tasks.answer({ answer: text, taskId: task.id });
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
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Your answer…"
          className="px-field min-w-0 flex-1"
          readOnly={submission.kind === "sending"}
          disabled={submission.kind === "sent"}
          autoFocus={autoFocus}
        />
        <button
          type="submit"
          disabled={!answer.trim() || disabled}
          className="px-btn-accent px-btn"
        >
          {submitLabel(submission)}
        </button>
      </form>
      <Failure submission={submission} doing="answer" />
    </div>
  );
};
