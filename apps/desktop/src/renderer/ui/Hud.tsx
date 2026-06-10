import { useStore, setAutopilot } from "@/renderer/state/store";

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function Stat({ label, value, sub, accent, onClick }: { label: string; value: string; sub?: string; accent?: string; onClick?: () => void }) {
  const body = (
    <>
      <div className="text-[9px] uppercase tracking-wide text-[#aab0c8]">{label}</div>
      <div className="text-[16px] leading-tight" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {sub ? <div className="text-[9px] text-[#8a90ab]">{sub}</div> : null}
    </>
  );
  if (onClick) {
    return (
      <button onClick={onClick} className="px-plate pointer-events-auto min-w-[58px] cursor-pointer px-3 py-1.5 text-center" title="Open the shipping log">
        {body}
      </button>
    );
  }
  return <div className="px-plate min-w-[58px] px-3 py-1.5 text-center">{body}</div>;
}

export function Hud({ onHire, onShips, onInbox }: { onHire: () => void; onShips: () => void; onInbox: () => void }) {
  const { company, employees, liveMetrics, pendingAsks } = useStore();
  if (!company) return null;
  const working = employees.filter((e) => e.status === "working").length;
  const version = `v${1 + Math.floor(company.ships / 10)}.${company.ships % 10}`;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-3">
      <div className="px-plate max-w-[20rem] px-3 py-2">
        <div className="text-[15px]">{company.name}</div>
        <div className="truncate text-[11px] text-[#c4c9dd]">{company.mission}</div>
      </div>

      <div className="flex items-stretch gap-2">
        <Stat label={liveMetrics ? "cash ⚡" : "cash"} value={`$${fmt(Math.floor(company.cash))}`} accent="#9fe6b0" sub={liveMetrics ? "real" : undefined} />
        <Stat label={liveMetrics ? "users ⚡" : "users"} value={fmt(company.users)} accent="#86c0ee" sub={liveMetrics ? "real" : undefined} />
        <Stat label="shipped" value={String(company.ships)} sub={version} onClick={onShips} />
        <Stat label="team" value={String(employees.length)} sub={working > 0 ? `${working} working` : "idle"} />
        <button
          onClick={onInbox}
          className="px-btn pointer-events-auto px-3 text-[12px]"
          style={pendingAsks.length > 0 ? { background: "var(--warn)", color: "#3a2c0a" } : undefined}
          title="Questions waiting on your call"
        >
          {pendingAsks.length > 0 ? <span className="px-live-dot">❗ {pendingAsks.length}</span> : "📥"}
        </button>
        <button
          onClick={() => void setAutopilot(!company.autopilot)}
          className="px-btn pointer-events-auto px-3 text-[12px]"
          style={company.autopilot ? { background: "var(--ok)", color: "#0e2a16" } : undefined}
          title={company.autopilot ? "Autopilot on — the team works on its own. Click to pause." : "Autopilot paused. Click to resume."}
        >
          {company.autopilot ? "● LIVE" : "⏸ Paused"}
        </button>
        <button onClick={onHire} className="px-btn-accent px-btn pointer-events-auto text-[14px]">
          + Hire
        </button>
      </div>
    </div>
  );
}
