import { useEffect, useState } from "react";
import { useNow } from "@/renderer/hooks/use-now";
import { useStore, digest } from "@/renderer/state/store";
import { Modal } from "@/renderer/ui/modal";
import { formatAway, formatNames, formatUsd, plural } from "@/shared/format";
import type { Digest as DigestSummary } from "@/shared/ipc-registry";

/** Shorter absences read as a glance away, not a return. */
const AWAY_MS = 10 * 60_000;
const SHIPS_SHOWN = 5;

const eventful = (d: DigestSummary): boolean =>
  d.ships.length + d.runs + d.hired.length + d.released.length + d.dead > 0;

const Lines = ({ d }: { d: DigestSummary }) => (
  <ul className="space-y-2 text-sm text-fg">
    {d.ships.length > 0 ? (
      <li>
        <span className="text-ok">{d.ships.length} shipped</span>
        <ul className="mt-1 space-y-0.5 text-xs text-fg-dim">
          {d.ships.slice(-SHIPS_SHOWN).map((s) => (
            <li key={s} className="truncate">
              · {s}
            </li>
          ))}
          {d.ships.length > SHIPS_SHOWN ? <li>· and {d.ships.length - SHIPS_SHOWN} more</li> : null}
        </ul>
      </li>
    ) : null}
    {d.runs > 0 ? (
      <li>
        {plural(d.runs, "run")} · {formatUsd(d.spentUsd)} spent
      </li>
    ) : null}
    {d.hired.length > 0 ? <li>Hired {formatNames(d.hired)}</li> : null}
    {d.released.length > 0 ? <li>Released {formatNames(d.released)}</li> : null}
    {d.dead > 0 ? (
      <li className="text-danger">{plural(d.dead, "task")} gave up — retry from the inbox</li>
    ) : null}
    {d.truncated ? (
      <li className="px-hint">The log ran out before then; these are floors.</li>
    ) : null}
  </ul>
);

/**
 * What happened while the founder was away. Asks on boot and whenever the
 * window comes back; main marks the moment it left, so the answer covers
 * exactly the absence, and asking is itself the next look.
 */
export const Digest = () => {
  const companyId = useStore((s) => s.company?.id ?? null);
  const now = useNow();
  const [summary, setSummary] = useState<DigestSummary | null>(null);

  useEffect(() => {
    if (companyId === null) {
      return;
    }
    const look = async () => {
      const d = await digest();
      if (d && eventful(d) && Date.now() - d.since >= AWAY_MS) {
        setSummary(d);
      }
    };
    const onFocus = () => {
      void look();
    };
    void look();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [companyId]);

  if (!summary) {
    return null;
  }
  return (
    <Modal
      title="While you were away"
      subtitle={`${formatAway(now - summary.since)} · the office kept working`}
      width="lg"
      onClose={() => setSummary(null)}
    >
      <Lines d={summary} />
    </Modal>
  );
};
