import { useEffect, useState } from "react";
import { useStore, setModalOpen, refresh, retryTask } from "@/renderer/state/store";
import { RichText } from "@/renderer/ui/linkify";
import type { Task } from "@/shared/domain";

/** The founder's inbox: pending asks plus dead-lettered/stuck tasks, all in one
 *  place (walking up to the "!" in the office still works — this is the fast path). */
export function Inbox({ onClose }: { onClose: () => void }) {
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
            <div className="text-[11px] text-[#c4c9dd]">
              {pendingAsks.length} question{pendingAsks.length === 1 ? "" : "s"} ·{" "}
              {stuckTasks.length} stuck
            </div>
          </div>
          <button onClick={onClose} className="px-btn text-[13px]">
            Done
          </button>
        </div>
        <div className="px-scroll flex-1 space-y-2 overflow-y-auto p-4">
          {pendingAsks.length === 0 && stuckTasks.length === 0 ? (
            <div className="text-[12px] text-[var(--text-dim)]">
              All clear — nobody's waiting on you.
            </div>
          ) : null}
          {pendingAsks.map((t) => (
            <AskRow key={t.id} t={t} by={nameOf(t.assigneeId)} companyId={company.id} />
          ))}
          {stuckTasks.length > 0 ? (
            <div className="pt-1 text-[9px] uppercase tracking-wide text-[#8a90ab]">
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

function StuckRow({ t, by }: { t: Task; by: string }) {
  const [retried, setRetried] = useState(false);
  const retry = async () => {
    if (retried || !t.assigneeId) return;
    setRetried(true);
    await retryTask(t);
  };
  return (
    <div className="px-inset p-3" style={{ opacity: retried ? 0.5 : 1 }}>
      <div className="text-[11px] text-[var(--danger)]">
        {t.status === "dead" ? "💀" : "⚠"} {by} ·{" "}
        <span className="text-[var(--text-dim)]">{t.title}</span>
      </div>
      {t.lastError ? (
        <div className="mt-1 text-[11px] leading-snug text-[var(--text-dim)]">{t.lastError}</div>
      ) : null}
      <div className="mt-2 flex justify-end">
        <button
          onClick={() => void retry()}
          disabled={retried || !t.assigneeId}
          className="px-btn-accent px-btn text-[12px]"
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
      <div className="text-[11px] text-[var(--danger)]">
        ❗ {by} · <span className="text-[var(--text-dim)]">{t.title}</span>
      </div>
      <div className="mt-1 text-[12px] leading-snug text-[var(--text)]">
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
          className="px-field flex-1 text-[12px]"
          disabled={sent}
        />
        <button
          onClick={() => void send()}
          disabled={!answer.trim() || sent}
          className="px-btn-accent px-btn text-[12px]"
        >
          {sent ? "Sent ✓" : "Answer"}
        </button>
      </div>
    </div>
  );
}
