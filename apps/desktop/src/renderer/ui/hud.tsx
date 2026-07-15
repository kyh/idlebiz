import { useStore, setAutopilot } from "@/renderer/state/store";
import { isOutOfBudget } from "@/shared/domain";

function fmt(n: number): string {
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1)}T`;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function Stat({
  label,
  value,
  sub,
  accent,
  title,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  title?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="text-[10px] uppercase tracking-wide text-[#c3c9de]">{label}</div>
      <div
        className="text-[17px] leading-tight tabular-nums"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </div>
      {sub ? <div className="text-[10px] tabular-nums text-[#a7adc6]">{sub}</div> : null}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="px-plate pointer-events-auto min-w-[64px] cursor-pointer px-3 py-1.5 text-center"
        title={title}
      >
        {body}
      </button>
    );
  }
  return <div className="px-plate min-w-[64px] px-3 py-1.5 text-center">{body}</div>;
}

/**
 * Four-corner HUD.
 *   top-left     the real scoreboard — revenue+spend (Stripe) and users (Vercel)
 *   top-right    the company — product state, team, notifications
 *   bottom-left  run controls — start/pause + settings
 *   (bottom-right is the TeamChannel component)
 */
export function Hud({
  onShips,
  onInbox,
  onBudget,
  onUsers,
  onSettings,
  onTeams,
}: {
  onShips: () => void;
  onInbox: () => void;
  onBudget: () => void;
  onUsers: () => void;
  onSettings: () => void;
  onTeams: () => void;
}) {
  const { company, employees, teams, pendingAsks, stuckTasks, product, resting } = useStore();
  if (!company) return null;
  const working = employees.filter((e) => e.status === "working").length;
  // a CLI on cooldown: the office naps until the earliest reset
  const napUntil = Object.values(resting)
    .filter((t) => t > Date.now())
    .toSorted((a, b) => a - b)[0];
  const napLabel =
    napUntil === undefined
      ? null
      : `☕ resting til ${new Date(napUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  const version = `v${1 + Math.floor(company.ships / 10)}.${company.ships % 10}`;
  const out = isOutOfBudget(company);
  const needsYou = pendingAsks.length + stuckTasks.length;

  const deploy = product?.deploy ?? null;
  const productState = deploy
    ? deploy.state === "READY"
      ? "LIVE"
      : deploy.state.toLowerCase()
    : product?.entry
      ? "local build"
      : "unshipped";

  return (
    <>
      {/* top-left: the money + adoption scoreboard (real numbers or connect) */}
      <div className="pointer-events-none absolute top-3 left-3 z-10 flex items-stretch gap-2">
        <Stat
          label={company.revenueUsd !== null ? "revenue ⚡" : "revenue"}
          value={company.revenueUsd === null ? "—" : `$${fmt(Math.floor(company.revenueUsd))}`}
          accent={out ? "var(--danger)" : "#9fe6b0"}
          sub={
            company.revenueUsd === null
              ? `spent $${company.spentUsd.toFixed(2)} · connect`
              : `spent $${company.spentUsd.toFixed(2)}${out ? " · OUT" : ""}`
          }
          title="Real Stripe revenue vs real AI spend — budget & Stripe live here"
          onClick={onBudget}
        />
        <Stat
          label={company.users !== null ? "users ⚡" : "users"}
          value={company.users === null ? "—" : fmt(company.users)}
          accent="#86c0ee"
          sub={company.users === null ? "connect" : "web analytics"}
          title="Real users from Vercel Web Analytics on your deployed product"
          onClick={onUsers}
        />
      </div>

      {/* top-right: the company — product, team, notifications */}
      <div className="pointer-events-none absolute top-3 right-3 z-10 flex items-stretch gap-2">
        <Stat
          label="product"
          value={version}
          accent={productState === "LIVE" ? "var(--ok)" : undefined}
          sub={`${productState} · ${company.ships} shipped`}
          title={deploy ? `Live at ${deploy.url}` : "Shipping log"}
          onClick={onShips}
        />
        <Stat
          label="team"
          value={String(employees.length)}
          sub={
            working > 0
              ? `${working} working`
              : (napLabel ??
                (teams.length > 0
                  ? `${teams.length} team${teams.length === 1 ? "" : "s"}`
                  : "idle"))
          }
          title={
            napLabel
              ? "A CLI hit its usage limit — parked work resumes automatically at reset"
              : "The roster sizes itself — your lever is the budget"
          }
          onClick={onTeams}
        />
        <button
          type="button"
          onClick={onInbox}
          className="px-btn pointer-events-auto"
          style={needsYou > 0 ? { background: "var(--warn)", color: "#3a2c0a" } : undefined}
          title="Questions, connect requests and stuck tasks waiting on you"
        >
          {needsYou > 0 ? (
            <span className="px-live-dot">
              <span className="px-icon">❗</span> {needsYou}
            </span>
          ) : (
            <span className="px-icon px-icon-solo">📥</span>
          )}
        </button>
      </div>

      {/* bottom-left: run controls */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex items-stretch gap-2">
        <button
          type="button"
          onClick={() => void setAutopilot(!company.autopilot)}
          className="px-btn pointer-events-auto"
          style={company.autopilot ? { background: "var(--ok)", color: "#0e2a16" } : undefined}
          title={
            company.autopilot
              ? "Autopilot on — the company runs itself. Click to pause."
              : "Autopilot paused. Click to resume."
          }
        >
          {company.autopilot ? (
            <>
              <span className="px-icon">●</span> LIVE
            </>
          ) : (
            <>
              <span className="px-icon">▶</span> Start
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onSettings}
          className="px-btn pointer-events-auto"
          title="Settings"
        >
          <span className="px-icon px-icon-solo">⚙</span>
        </button>
      </div>
    </>
  );
}
