import { useEffect, useState } from "react";
import { useStore, setModalOpen } from "@/renderer/state/store";
import { RichText } from "@/renderer/ui/linkify";
import type { Task } from "@/shared/domain";

// ---------------------------------------------------------------------------
// Shipping log: everything the team has shipped, with summaries that say where
// the output lives, plus one-click access to the real workspace + product.
// ---------------------------------------------------------------------------

/** One ship: a single line that expands to the full "what & where" summary,
 *  with every URL and workspace path clickable. */
function ShipRow({ t, by, companyId }: { t: Task; by: string; companyId: string }) {
  const [open, setOpen] = useState(false);
  const summary = t.summary ?? "";
  const firstLine = summary.split("\n").find((l) => l.trim() !== "") ?? "";
  return (
    <div className="px-inset p-2.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline gap-2 text-left"
      >
        <span className="text-[11px] text-[var(--text-dim)]">{open ? "▼" : "▶"}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-[var(--text)]">
            📦 {firstLine || t.title}
          </span>
        </span>
        <span className="shrink-0 text-[11px] text-[var(--text-dim)]">
          {by} · {new Date(t.completedAt ?? t.createdAt).toLocaleDateString()}
        </span>
      </button>
      {open ? (
        <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-[#4c5064]">
          <RichText text={summary.slice(0, 1500)} companyId={companyId} />
        </p>
      ) : null}
    </div>
  );
}

export function Ships({ onClose }: { onClose: () => void }) {
  const { company, employees } = useStore();
  const [ships, setShips] = useState<Task[] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, []);

  useEffect(() => {
    const bridge = window.appBridge;
    if (!company || !bridge) return;
    let alive = true;
    void (async () => {
      const tasks = await bridge.listTasks({ companyId: company.id });
      if (alive) setShips(tasks.filter((t) => t.status === "done" && t.summary));
    })();
    return () => {
      alive = false;
    };
  }, [company]);

  if (!company) return null;
  const nameOf = (id: string | null): string => employees.find((e) => e.id === id)?.name ?? "team";

  const open = async (rel: string) => {
    const bridge = window.appBridge;
    if (!bridge) return;
    try {
      await bridge.openCompanyPath({ companyId: company.id, rel });
    } catch (e: unknown) {
      setNote(e instanceof Error ? e.message : String(e));
      window.setTimeout(() => setNote(null), 2500);
    }
  };

  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-6">
      <div className="px-window flex max-h-[88vh] w-full max-w-3xl flex-col">
        <div className="px-titlebar flex items-center justify-between px-4 py-2.5">
          <div>
            <div className="text-[16px]">Shipping log</div>
            <div className="text-[12px] text-[#c4c9dd]">
              {company.ships} shipped · everything your team built lives in the workspace
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void open("")}
              className="px-btn"
              title="Reveal the real folder where the team works"
            >
              📁 Workspace
            </button>
            <button
              type="button"
              onClick={() => {
                const bridge = window.appBridge;
                if (!bridge) return;
                bridge.openProduct({ companyId: company.id }).catch((e: unknown) => {
                  setNote(e instanceof Error ? e.message : String(e));
                  window.setTimeout(() => setNote(null), 2500);
                });
              }}
              className="px-btn"
              title="Open the product (via workspace/PRODUCT.md, falls back to index.html)"
            >
              ▶ Product
            </button>
            <button type="button" onClick={onClose} className="px-btn">
              Done
            </button>
          </div>
        </div>

        {note ? <div className="px-3 pt-2 text-[12px] text-[var(--danger)]">{note}</div> : null}

        <div className="px-scroll flex-1 space-y-2 overflow-y-auto p-4">
          {ships === null ? (
            <div className="text-[13px] text-[var(--text-dim)]">Loading…</div>
          ) : ships.length === 0 ? (
            <div className="text-[13px] text-[var(--text-dim)]">
              Nothing shipped yet — the team is just getting started.
            </div>
          ) : (
            ships
              .toReversed()
              .map((t) => (
                <ShipRow key={t.id} t={t} by={nameOf(t.assigneeId)} companyId={company.id} />
              ))
          )}
        </div>
      </div>
    </div>
  );
}
