import { useState } from "react";
import { answerQuestion } from "@/renderer/state/store";
import type { Task } from "@/shared/domain";

/** The founder answers the question a blocked task is waiting on; the task resumes. */
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
  const [sent, setSent] = useState(false);

  const send = async () => {
    const text = answer.trim();
    if (!text || sent) return;
    setSent(true);
    onSent?.();
    await answerQuestion(task.id, text);
  };

  return (
    <div className="mt-2 flex gap-2">
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
        disabled={sent}
        autoFocus={autoFocus}
      />
      <button
        type="button"
        onClick={() => void send()}
        disabled={!answer.trim() || sent}
        className="px-btn-accent px-btn"
      >
        {sent ? "Sent ✓" : "Answer"}
      </button>
    </div>
  );
}
