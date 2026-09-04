import { useEffect, useState } from "react";
import { useTransientNote } from "@/renderer/hooks/use-transient-note";
import { bridge, useStore } from "@/renderer/state/store";
import { employeeName } from "@/renderer/ui/employee-name";
import { RichText } from "@/renderer/ui/linkify";
import { Modal } from "@/renderer/ui/modal";
import type { Task } from "@/shared/domain";
import { errorMessage } from "@/shared/errors";
import { formatDate } from "@/shared/format";

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
        <span className="text-xs text-[var(--text-dim)]">{open ? "▼" : "▶"}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-[var(--text)]">
            📦 {firstLine || t.title}
          </span>
        </span>
        <span className="shrink-0 text-xs text-[var(--text-dim)]">
          {by} · {formatDate(t.completedAt ?? t.createdAt)}
        </span>
      </button>
      {open ? (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[#4c5064]">
          <RichText text={summary.slice(0, 1500)} companyId={companyId} />
        </p>
      ) : null}
    </div>
  );
}

export function Ships({ onClose }: { onClose: () => void }) {
  const company = useStore((s) => s.company);
  const employees = useStore((s) => s.employees);
  const [ships, setShips] = useState<Task[] | null>(null);
  const [note, showNote] = useTransientNote(2500);

  useEffect(() => {
    if (!company) return;
    let alive = true;
    void (async () => {
      const tasks = await bridge().listTasks({ companyId: company.id });
      if (alive) setShips(tasks.filter((t) => t.status === "done" && t.summary));
    })();
    return () => {
      alive = false;
    };
  }, [company]);

  if (!company) return null;
  const companyId = company.id;

  const openWorkspace = () =>
    bridge()
      .openCompanyPath({ companyId, rel: "" })
      .catch((cause) => showNote(errorMessage(cause)));
  const openProduct = () =>
    bridge()
      .openProduct({ companyId })
      .catch((cause) => showNote(errorMessage(cause)));

  return (
    <Modal
      title="Shipping log"
      subtitle={`${company.ships} shipped · everything your team built lives in the workspace`}
      width="3xl"
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            onClick={() => void openWorkspace()}
            className="px-btn"
            title="Reveal the real folder where the team works"
          >
            📁 Workspace
          </button>
          <button
            type="button"
            onClick={() => void openProduct()}
            className="px-btn"
            title="Open the product (via workspace/PRODUCT.md, falls back to index.html)"
          >
            ▶ Product
          </button>
        </>
      }
    >
      <div className="space-y-2">
        {note ? <div className="text-xs text-[var(--danger)]">{note}</div> : null}
        {ships === null ? (
          <div className="text-sm text-[var(--text-dim)]">Loading…</div>
        ) : ships.length === 0 ? (
          <div className="text-sm text-[var(--text-dim)]">
            Nothing shipped yet — the team is just getting started.
          </div>
        ) : (
          ships
            .toReversed()
            .map((t) => (
              <ShipRow
                key={t.id}
                t={t}
                by={employeeName(employees, t.assigneeId, "team")}
                companyId={companyId}
              />
            ))
        )}
      </div>
    </Modal>
  );
}
