import { useState } from "react";
import { useStore, resolveApproval, retryTask } from "@/renderer/state/store";
import { AnswerForm } from "@/renderer/ui/answer-form";
import { employeeName } from "@/renderer/ui/employee-name";
import { RichText } from "@/renderer/ui/linkify";
import { Modal } from "@/renderer/ui/modal";
import { INTEGRATION_LABELS, classifyCommand } from "@/shared/domain";
import type { IntegrationKind, Task } from "@/shared/domain";

/** The founder's inbox: pending asks plus dead-lettered/stuck tasks, all in one
 *  place (walking up to the "!" in the office still works — this is the fast path). */
export function Inbox({
  onClose,
  onConnect,
}: {
  onClose: () => void;
  /** Launch the connect flow for a typed integration ask. */
  onConnect: (kind: IntegrationKind) => void;
}) {
  const company = useStore((s) => s.company);
  const employees = useStore((s) => s.employees);
  const pendingAsks = useStore((s) => s.pendingAsks);
  const stuckTasks = useStore((s) => s.stuckTasks);

  if (!company) return null;
  const nameOf = (id: string | null): string => employeeName(employees, id, "someone");

  return (
    <Modal
      title="Inbox"
      subtitle={`${pendingAsks.length} question${pendingAsks.length === 1 ? "" : "s"} · ${stuckTasks.length} stuck`}
      width="2xl"
      onClose={onClose}
    >
      <div className="space-y-2">
        {pendingAsks.length === 0 && stuckTasks.length === 0 ? (
          <div className="text-sm text-text-dim">All clear — nobody's waiting on you.</div>
        ) : null}
        {pendingAsks.map((t) => {
          if (t.blocked?.type === "integration")
            return (
              <ConnectRow
                key={t.id}
                t={t}
                by={nameOf(t.assigneeId)}
                integration={t.blocked.integration}
                reason={t.blocked.reason}
                onConnect={onConnect}
              />
            );
          if (t.blocked?.type === "approval")
            return (
              <ApprovalRow key={t.id} t={t} by={nameOf(t.assigneeId)} command={t.blocked.command} />
            );
          return <AskRow key={t.id} t={t} by={nameOf(t.assigneeId)} companyId={company.id} />;
        })}
        {stuckTasks.length > 0 ? (
          <div className="pt-1 text-xs uppercase tracking-wide text-text-dim">
            Stuck — needs a retry
          </div>
        ) : null}
        {stuckTasks.map((t) => (
          <StuckRow key={t.id} t={t} by={nameOf(t.assigneeId)} />
        ))}
      </div>
    </Modal>
  );
}

/** A typed integration ask: the agent needs a real-world connection. Connecting
 *  resumes the blocked task automatically — no text answer required. */
function ConnectRow({
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
}) {
  const label = INTEGRATION_LABELS[integration];
  return (
    <div className="px-inset p-3">
      <div className="text-xs text-accent-lo">
        🔌 {by} · <span className="text-text-dim">{t.title}</span>
      </div>
      <div className="mt-1 text-sm leading-snug text-text">
        {reason || `The team needs ${label} connected to keep going.`}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-text-dim">
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
}

/** An outward-facing command held at the tool boundary. The founder sees the
 *  exact command, because that is what will run if they say yes. */
function ApprovalRow({ t, by, command }: { t: Task; by: string; command: string }) {
  const [sent, setSent] = useState(false);
  const verdict = classifyCommand(command);
  const decide = async (approved: boolean) => {
    if (sent) return;
    setSent(true);
    await resolveApproval(t.id, approved);
  };
  return (
    <div className="px-inset p-3" style={{ opacity: sent ? 0.5 : 1 }}>
      <div className="text-xs text-warn">
        🔐 {by} · <span className="text-text-dim">{t.title}</span>
      </div>
      <div className="mt-1 text-sm leading-snug text-text">
        {verdict.decision === "ask" ? verdict.rule.describe : "Wants to run this."}
      </div>
      <pre className="px-inset px-code mt-2 overflow-x-auto p-2">{command}</pre>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-text-dim">Approving covers this exact command, once.</span>
        <span className="flex gap-2">
          <button
            type="button"
            onClick={() => void decide(false)}
            disabled={sent}
            className="px-btn"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => void decide(true)}
            disabled={sent}
            className="px-btn-accent px-btn"
          >
            Approve
          </button>
        </span>
      </div>
    </div>
  );
}

function StuckRow({ t, by }: { t: Task; by: string }) {
  const [retried, setRetried] = useState(false);
  const retry = async () => {
    if (retried || !t.assigneeId) return;
    setRetried(true);
    await retryTask(t);
  };
  return (
    <div className="px-inset p-3" style={{ opacity: retried ? 0.5 : 1 }}>
      <div className="text-xs text-danger">
        {t.status === "dead" ? "💀" : "⚠"} {by} · <span className="text-text-dim">{t.title}</span>
      </div>
      {t.lastError ? (
        <div className="mt-1 text-xs leading-snug text-text-dim">{t.lastError}</div>
      ) : null}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => void retry()}
          disabled={retried || !t.assigneeId}
          className="px-btn-accent px-btn"
        >
          {retried ? "Retrying…" : "Retry"}
        </button>
      </div>
    </div>
  );
}

function AskRow({ t, by, companyId }: { t: Task; by: string; companyId: string }) {
  const [sent, setSent] = useState(false);
  return (
    <div className="px-inset p-3" style={{ opacity: sent ? 0.5 : 1 }}>
      <div className="text-xs text-danger">
        ❗ {by} · <span className="text-text-dim">{t.title}</span>
      </div>
      <div className="mt-1 text-sm leading-snug text-text">
        <RichText
          text={t.blocked?.type === "question" ? t.blocked.question : ""}
          companyId={companyId}
        />
      </div>
      <AnswerForm task={t} onSent={() => setSent(true)} />
    </div>
  );
}
