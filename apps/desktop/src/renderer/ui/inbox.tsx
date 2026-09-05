import { useState } from "react";
import { useStore, resolveApproval, retryTask } from "@/renderer/state/store";
import { AnswerForm } from "@/renderer/ui/answer-form";
import { employeeName } from "@/renderer/ui/employee-name";
import { RichText } from "@/renderer/ui/linkify";
import { Modal } from "@/renderer/ui/modal";
import { describeRule, type RuleId } from "@/shared/command-policy";
import { INTEGRATION_LABELS } from "@/shared/domain";
import type { Overlay } from "@/renderer/ui/hud";
import type { IntegrationKind, Task, TaskIn } from "@/shared/domain";

/** The founder's inbox: pending asks plus dead-lettered/stuck tasks, all in one
 *  place (walking up to the "!" in the office still works — this is the fast path). */
export function Inbox({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  /** The connect flow for a typed integration ask lives in another window. */
  onOpen: (overlay: Overlay) => void;
}) {
  const company = useStore((s) => s.company);
  const employees = useStore((s) => s.employees);
  const products = useStore((s) => s.products);
  const pendingAsks = useStore((s) => s.pendingAsks);
  const stuckTasks = useStore((s) => s.stuckTasks);

  if (!company) return null;
  const nameOf = (id: string | null): string => employeeName(employees, id, "someone");
  // Stripe is the company's; Vercel binds the product the ask came from
  const connect = (kind: IntegrationKind, t: Task): void => {
    if (kind === "stripe") {
      onOpen({ kind: "budget" });
      return;
    }
    const productId = t.productId ?? products[0]?.id;
    if (productId !== undefined) onOpen({ kind: "vercel", productId });
  };

  return (
    <Modal
      title="Inbox"
      subtitle={`${pendingAsks.length} question${pendingAsks.length === 1 ? "" : "s"} · ${stuckTasks.length} stuck`}
      width="2xl"
      onClose={onClose}
    >
      <div className="space-y-2">
        {pendingAsks.length === 0 && stuckTasks.length === 0 ? (
          <div className="text-sm text-fg-dim">All clear — nobody's waiting on you.</div>
        ) : null}
        {pendingAsks.map((t) => {
          const { ask } = t.state;
          switch (ask.type) {
            case "integration":
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
            case "approval":
              return (
                <ApprovalRow
                  key={t.id}
                  t={t}
                  by={nameOf(t.assigneeId)}
                  command={ask.command}
                  rule={ask.rule}
                />
              );
            case "question":
              return (
                <AskRow
                  key={t.id}
                  t={t}
                  by={nameOf(t.assigneeId)}
                  question={ask.question}
                  companyId={company.id}
                />
              );
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
}

/** An outward-facing command held at the tool boundary. The founder sees the
 *  exact command, because that is what will run if they say yes. */
function ApprovalRow({
  t,
  by,
  command,
  rule,
}: {
  t: Task;
  by: string;
  command: string;
  rule: RuleId;
}) {
  const [sent, setSent] = useState(false);
  const decide = async (approved: boolean) => {
    if (sent) return;
    setSent(true);
    await resolveApproval(t.id, approved);
  };
  return (
    <div className="px-inset p-3" style={{ opacity: sent ? 0.5 : 1 }}>
      <div className="text-xs text-warn">
        🔐 {by} · <span className="text-fg-dim">{t.title}</span>
      </div>
      <div className="mt-1 text-sm leading-snug text-fg">{describeRule(rule)}</div>
      <pre className="px-inset px-code mt-2 overflow-x-auto p-2">{command}</pre>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-fg-dim">Approving covers this exact command, once.</span>
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

function StuckRow({ t, by }: { t: TaskIn<"dead">; by: string }) {
  const [retried, setRetried] = useState(false);
  const retry = async () => {
    if (retried || !t.assigneeId) return;
    setRetried(true);
    await retryTask(t);
  };
  return (
    <div className="px-inset p-3" style={{ opacity: retried ? 0.5 : 1 }}>
      <div className="text-xs text-danger">
        💀 {by} · <span className="text-fg-dim">{t.title}</span>
      </div>
      <div className="mt-1 text-xs leading-snug text-fg-dim">{t.state.lastError}</div>
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

function AskRow({
  t,
  by,
  question,
  companyId,
}: {
  t: Task;
  by: string;
  question: string;
  companyId: string;
}) {
  const [sent, setSent] = useState(false);
  return (
    <div className="px-inset p-3" style={{ opacity: sent ? 0.5 : 1 }}>
      <div className="text-xs text-danger">
        ❗ {by} · <span className="text-fg-dim">{t.title}</span>
      </div>
      <div className="mt-1 text-sm leading-snug text-fg">
        <RichText text={question} companyId={companyId} />
      </div>
      <AnswerForm task={t} onSent={() => setSent(true)} />
    </div>
  );
}
