import { useStore, setAutopilot } from "@/renderer/state/store";
import { isOutOfBudget } from "@/shared/domain";

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function Stat({
  label,
  value,
  sub,
  accent,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  onClick?: () => void;
}) {
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
      <button
        onClick={onClick}
        className="px-plate pointer-events-auto min-w-[58px] cursor-pointer px-3 py-1.5 text-center"
        title="Open the shipping log"
      >
        {body}
      </button>
    );
  }
  return <div className="px-plate min-w-[58px] px-3 py-1.5 text-center">{body}</div>;
}

export function Hud({
  onHire,
  onShips,
  onInbox,
  onBudget,
  onSettings,
  onTeams,
}: {
  onHire: () => void;
  onShips: () => void;
  onInbox: () => void;
  onBudget: () => void;
  onSettings: () => void;
  onTeams: () => void;
}) {
  const { company, employees, teams, liveMetrics, pendingAsks, stuckTasks } = useStore();
  if (!company) return null;
  const working = employees.filter((e) => e.status === "working").length;
  const version = `v${1 + Math.floor(company.ships / 10)}.${company.ships % 10}`;
  const out = isOutOfBudget(company);
  const budgetValue = out
    ? "OUT"
    : company.budget.mode === "infinite"
      ? "∞"
      : `$${(company.budget.capUsd - company.spentUsd).toFixed(2)}`;

  return (
    <div className="pointer-events-none absolute top-3 right-3 z-10 flex max-w-[34rem] flex-col items-end gap-2">
      <div className="flex flex-wrap items-stretch justify-end gap-2">
        <Stat
          label={liveMetrics ? "cash ⚡" : "cash"}
          value={`$${fmt(Math.floor(company.cash))}`}
          accent="#9fe6b0"
          sub={liveMetrics ? "real" : undefined}
        />
        <Stat
          label={liveMetrics ? "users ⚡" : "users"}
          value={fmt(company.users)}
          accent="#86c0ee"
          sub={liveMetrics ? "real" : undefined}
        />
        <Stat label="shipped" value={String(company.ships)} sub={version} onClick={onShips} />
        <Stat
          label="team"
          value={String(employees.length)}
          sub={
            teams.length > 0
              ? `${teams.length} team${teams.length === 1 ? "" : "s"}`
              : working > 0
                ? `${working} working`
                : "idle"
          }
          onClick={onTeams}
        />
        <Stat
          label="budget"
          value={budgetValue}
          accent={out ? "var(--danger)" : "#e8d28a"}
          sub={`spent $${company.spentUsd.toFixed(2)}`}
          onClick={onBudget}
        />
        <button
          onClick={onInbox}
          className="px-btn pointer-events-auto px-3 text-[12px]"
          style={
            pendingAsks.length + stuckTasks.length > 0
              ? { background: "var(--warn)", color: "#3a2c0a" }
              : undefined
          }
          title="Questions and stuck tasks waiting on you"
        >
          {pendingAsks.length + stuckTasks.length > 0 ? (
            <span className="px-live-dot">❗ {pendingAsks.length + stuckTasks.length}</span>
          ) : (
            "📥"
          )}
        </button>
        <button
          onClick={() => void setAutopilot(!company.autopilot)}
          className="px-btn pointer-events-auto px-3 text-[12px]"
          style={company.autopilot ? { background: "var(--ok)", color: "#0e2a16" } : undefined}
          title={
            company.autopilot
              ? "Autopilot on — the team works on its own. Click to pause."
              : "Autopilot paused. Click to resume."
          }
        >
          {company.autopilot ? "● LIVE" : "⏸ Paused"}
        </button>
        <button onClick={onHire} className="px-btn-accent px-btn pointer-events-auto text-[14px]">
          + Hire
        </button>
        <button
          onClick={onSettings}
          className="px-btn pointer-events-auto px-3 text-[12px]"
          title="Settings"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}
