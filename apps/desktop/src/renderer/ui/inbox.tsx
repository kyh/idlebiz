import { useEffect, useState } from "react";
import { useStore, setModalOpen, refresh, retryTask } from "@/renderer/state/store";
import { RichText } from "@/renderer/ui/linkify";
import { parseIntegrationAsk } from "@/shared/domain";
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
  const { company, employees, pendingAsks, stuckTasks } = useStore();

  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, []);

  if (!company) return null;
  const nameOf = (id: string | null): string =>
    employees.find((e) => e.id === id)?.name ?? "someone";

  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-6">
      <div className="px-window flex max-h-[80vh] w-full max-w-2xl flex-col">
        <div className="px-titlebar flex items-center justify-between px-4 py-2.5">
          <div>
            <div className="text-[16px]">Inbox</div>
            <div className="text-[12px] text-[#c4c9dd]">
              {pendingAsks.length} question{pendingAsks.length === 1 ? "" : "s"} ·{" "}
              {stuckTasks.length} stuck
            </div>
          </div>
          <button onClick={onClose} className="px-btn">
            Done
          </button>
        </div>
        <div className="px-scroll flex-1 space-y-2 overflow-y-auto p-4">
          {pendingAsks.length === 0 && stuckTasks.length === 0 ? (
            <div className="text-[13px] text-[var(--text-dim)]">
              All clear — nobody's waiting on you.
            </div>
          ) : null}
          {pendingAsks.map((t) => {
            const ask = t.blockedQuestion ? parseIntegrationAsk(t.blockedQuestion) : null;
            return ask ? (
              <ConnectRow
                key={t.id}
                t={t}
                by={nameOf(t.assigneeId)}
                ask={ask}
                onConnect={onConnect}
              />
            ) : (
              <AskRow key={t.id} t={t} by={nameOf(t.assigneeId)} companyId={company.id} />
            );
          })}
          {stuckTasks.length > 0 ? (
            <div className="pt-1 text-[10px] uppercase tracking-wide text-[var(--text-dim)]">
              Stuck — needs a retry
            </div>
          ) : null}
          {stuckTasks.map((t) => (
            <StuckRow key={t.id} t={t} by={nameOf(t.assigneeId)} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** A typed integration ask: the agent needs a real-world connection. Connecting
 *  resumes the blocked task automatically — no text answer required. */
function ConnectRow({
  t,
  by,
  ask,
  onConnect,
}: {
  t: Task;
  by: string;
  ask: { kind: IntegrationKind; reason: string };
  onConnect: (kind: IntegrationKind) => void;
}) {
  const label = ask.kind === "vercel" ? "Vercel" : "Stripe";
  return (
    <div className="px-inset p-3">
      <div className="text-[12px] text-[var(--accent-lo)]">
        🔌 {by} · <span className="text-[var(--text-dim)]">{t.title}</span>
      </div>
      <div className="mt-1 text-[13px] leading-snug text-[var(--text)]">
        {ask.reason || `The team needs ${label} connected to keep going.`}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-[var(--text-dim)]">
          Their task resumes automatically once connected.
        </span>
        <button onClick={() => onConnect(ask.kind)} className="px-btn-accent px-btn">
          Connect {label}
        </button>
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
      <div className="text-[12px] text-[var(--danger)]">
        {t.status === "dead" ? "💀" : "⚠"} {by} ·{" "}
        <span className="text-[var(--text-dim)]">{t.title}</span>
      </div>
      {t.lastError ? (
        <div className="mt-1 text-[12px] leading-snug text-[var(--text-dim)]">{t.lastError}</div>
      ) : null}
      <div className="mt-2 flex justify-end">
        <button
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
  const [answer, setAnswer] = useState("");
  const [sent, setSent] = useState(false);

  const send = async () => {
    const text = answer.trim();
    const bridge = window.appBridge;
    if (!text || !bridge || sent) return;
    setSent(true);
    await bridge.answerQuestion({ taskId: t.id, answer: text });
    await refresh();
  };

  return (
    <div className="px-inset p-3" style={{ opacity: sent ? 0.5 : 1 }}>
      <div className="text-[12px] text-[var(--danger)]">
        ❗ {by} · <span className="text-[var(--text-dim)]">{t.title}</span>
      </div>
      <div className="mt-1 text-[13px] leading-snug text-[var(--text)]">
        <RichText text={t.blockedQuestion ?? ""} companyId={companyId} />
      </div>
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
        />
        <button
          onClick={() => void send()}
          disabled={!answer.trim() || sent}
          className="px-btn-accent px-btn"
        >
          {sent ? "Sent ✓" : "Answer"}
        </button>
      </div>
    </div>
  );
}
