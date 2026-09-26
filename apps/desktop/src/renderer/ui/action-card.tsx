import { useState } from "react";
import { useSubmission } from "@/renderer/hooks/use-submission";
import { copyText, resolveAction } from "@/renderer/state/store";
import { Failure } from "@/renderer/ui/failure";
import { RichText } from "@/renderer/ui/linkify";
import type { ActionAsk, ActionReply, Task } from "@/shared/domain";
import { cn } from "cn";

const Draft = ({ text }: { text: string }) => {
  const { submission, submit } = useSubmission(() => copyText(text));
  return (
    <div className="mt-2">
      <pre className="px-inset px-draft px-scroll max-h-40 overflow-y-auto p-2">{text}</pre>
      <div className="mt-1 flex justify-end">
        <button type="button" onClick={() => submit()} className="px-btn">
          {submission.kind === "sent" ? "Copied ✓" : "Copy draft"}
        </button>
      </div>
      <Failure submission={submission} doing="copy" />
    </div>
  );
};

/**
 * A step only the founder can take, as the teammate wrote it up. Done carries whatever they
 * type back to the run as written, a product's key included, into the continuation's TASK.md,
 * which every run can read; Can't carries why.
 */
export const ActionCard = ({ t, by, ask }: { t: Task; by: string; ask: ActionAsk }) => {
  const [text, setText] = useState("");
  const { submission, submit } = useSubmission((reply: ActionReply) => resolveAction(t.id, reply));
  const decided = submission.kind === "sending" || submission.kind === "sent";
  const said = text.trim();
  return (
    <div className={cn("px-inset p-3", decided && "opacity-50")}>
      <div className="text-xs text-accent-lo">
        ✋ {by} · <span className="text-fg-dim">{t.title}</span>
      </div>
      <div className="mt-1 text-sm leading-snug text-fg">{ask.action}</div>
      <div className="mt-1 whitespace-pre-wrap text-xs leading-snug text-fg-dim">
        <RichText text={ask.instructions} />
      </div>
      {ask.draft === null ? null : <Draft text={ask.draft} />}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What to send back (a URL, a value), or why you can't"
        aria-label="Reply"
        className="px-field mt-2 w-full min-w-0"
        disabled={decided}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-fg-dim">
          {by}&apos;s run gets what you type, as written, and it stays in the task, where any
          teammate can read it.
        </span>
        <span className="flex gap-2">
          <button
            type="button"
            onClick={() => submit({ kind: "cant", reason: said })}
            disabled={decided || said === ""}
            aria-label={`Can't: ${ask.action}`}
            className="px-btn"
          >
            Can&apos;t
          </button>
          <button
            type="button"
            onClick={() => submit({ kind: "done", note: said })}
            disabled={decided}
            aria-label={`Done: ${ask.action}`}
            className="px-btn-accent px-btn"
          >
            Done
          </button>
        </span>
      </div>
      <Failure submission={submission} />
    </div>
  );
};
