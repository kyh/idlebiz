import { useState } from "react";
import { useSubmission } from "@/renderer/hooks/use-submission";
import { useStore, resolveApproval, retryTask } from "@/renderer/state/store";
import { AnswerForm } from "@/renderer/ui/answer-form";
import { employeeName } from "@/renderer/ui/employee-name";
import { Failure } from "@/renderer/ui/failure";
import { RichText } from "@/renderer/ui/linkify";
import { Modal } from "@/renderer/ui/modal";
import { plural } from "@/shared/format";
import { describeRule } from "@/shared/hold-rules";
import { INTEGRATION_LABELS } from "@/shared/domain";
import type { Overlay } from "@/renderer/ui/overlay";
import type { IntegrationKind, Task, TaskIn } from "@/shared/domain";
import { cn } from "cn";

// Connecting resumes integration asks automatically; no text answer is needed.
const ConnectRow = ({
  t,
  by,
  integration,
  reason,
  onConnect,
}: {
  t: Task;
  by: string;
  integration: IntegrationKind;
  reason: string;
  onConnect: (kind: IntegrationKind) => void;
}) => {
  const label = INTEGRATION_LABELS[integration];
  return (
    <div className="px-inset p-3">
      <div className="text-xs text-accent-lo">
        🔌 {by} · <span className="text-fg-dim">{t.title}</span>
      </div>
      <div className="mt-1 text-sm leading-snug text-fg">
        {reason || `The team needs ${label} connected to keep going.`}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-fg-dim">
          Their task resumes automatically once connected.
        </span>
        <button
          type="button"
          onClick={() => onConnect(integration)}
          className="px-btn-accent px-btn"
        >
          Connect {label}
        </button>
      </div>
    </div>
  );
};

// Show the exact held command; approval authorizes it once.
const ApprovalRow = ({
  t,
  by,
  command,
  rule,
}: {
  t: Task;
  by: string;
  command: string;
  rule: string;
}) => {
  const { submission, submit } = useSubmission((approved: boolean) =>
    resolveApproval(t.id, approved),
  );
  const decided = submission.kind === "sending" || submission.kind === "sent";
  return (
    <div className={cn("px-inset p-3", decided && "opacity-50")}>
      <div className="text-xs text-warn">
        🔐 {by} · <span className="text-fg-dim">{t.title}</span>
      </div>
      <div className="mt-1 text-sm leading-snug text-fg">{describeRule(rule)}</div>
      <pre className="px-inset px-code mt-2 overflow-x-auto p-2">{command}</pre>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-fg-dim">Approving covers this exact command, once.</span>
        <span className="flex gap-2">
          <button type="button" onClick={() => submit(false)} disabled={decided} className="px-btn">
            Deny
          </button>
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={decided}
            className="px-btn-accent px-btn"
          >
            Approve
          </button>
        </span>
      </div>
      <Failure submission={submission} />
    </div>
  );
};

const StuckRow = ({ t, by }: { t: TaskIn<"dead">; by: string }) => {
  const { submission, submit } = useSubmission(() => retryTask(t));
  const retried = submission.kind === "sending" || submission.kind === "sent";
  return (
    <div className={cn("px-inset p-3", retried && "opacity-50")}>
      <div className="text-xs text-danger">
        💀 {by} · <span className="text-fg-dim">{t.title}</span>
      </div>
      <div className="mt-1 text-xs leading-snug text-fg-dim">{t.state.lastError}</div>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => submit()}
          disabled={retried || !t.assigneeId}
          className="px-btn-accent px-btn"
        >
          {retried ? "Retrying…" : "Retry"}
        </button>
      </div>
      <Failure submission={submission} />
    </div>
  );
};

const AskRow = ({ t, by, question }: { t: Task; by: string; question: string }) => {
  const [sent, setSent] = useState(false);
  return (
    <div className={cn("px-inset p-3", sent && "opacity-50")}>
      <div className="text-xs text-danger">
        ❗ {by} · <span className="text-fg-dim">{t.title}</span>
      </div>
      <div className="mt-1 text-sm leading-snug text-fg">
        <RichText text={question} />
      </div>
      <AnswerForm task={t} onSent={() => setSent(true)} />
    </div>
  );
};

export const Inbox = ({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  /** The connect flow for a typed integration ask lives in another window. */
  onOpen: (overlay: Overlay) => void;
}) => {
  const company = useStore((s) => s.company);
  const employees = useStore((s) => s.employees);
  const pendingAsks = useStore((s) => s.pendingAsks);
  const stuckTasks = useStore((s) => s.stuckTasks);

  if (!company) {
    return null;
  }
  const nameOf = (id: string | null): string => employeeName(employees, id, "someone");
  // Stripe is the company's; Vercel binds the product the ask came from, or asks which
  const connect = (kind: IntegrationKind, t: Task): void => {
    onOpen(kind === "stripe" ? { kind: "budget" } : { kind: "vercel", productId: t.productId });
  };

  return (
    <Modal
      title="Inbox"
      subtitle={`${plural(pendingAsks.length, "question")} · ${stuckTasks.length} stuck`}
      width="2xl"
      onClose={onClose}
    >
      <div className="space-y-2">
        {pendingAsks.length === 0 && stuckTasks.length === 0 ? (
          <div className="text-sm text-fg-dim">All clear — nobody&apos;s waiting on you.</div>
        ) : null}
        {pendingAsks.map((t) => {
          const { ask } = t.state;
          switch (ask.type) {
            case "integration": {
              return (
                <ConnectRow
                  key={t.id}
                  t={t}
                  by={nameOf(t.assigneeId)}
                  integration={ask.integration}
                  reason={ask.reason}
                  onConnect={(kind) => connect(kind, t)}
                />
              );
            }
            case "approval": {
              return (
                <ApprovalRow
                  key={t.id}
                  t={t}
                  by={nameOf(t.assigneeId)}
                  command={ask.command}
                  rule={ask.rule}
                />
              );
            }
            case "question": {
              return <AskRow key={t.id} t={t} by={nameOf(t.assigneeId)} question={ask.question} />;
            }
            default: {
              return null;
            }
          }
        })}
        {stuckTasks.length > 0 ? (
          <div className="pt-1 text-xs uppercase tracking-wide text-fg-dim">
            Stuck — needs a retry
          </div>
        ) : null}
        {stuckTasks.map((t) => (
          <StuckRow key={t.id} t={t} by={nameOf(t.assigneeId)} />
        ))}
      </div>
    </Modal>
  );
};
