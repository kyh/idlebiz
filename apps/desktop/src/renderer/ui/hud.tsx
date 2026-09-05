import { useNow } from "@/renderer/hooks/use-now";
import { useStore, setAutopilot } from "@/renderer/state/store";
import { isOutOfBudget } from "@/shared/domain";
import type { Company, Employee } from "@/shared/domain";
import type { ProductStatus } from "@/shared/ipc-registry";
import { earliestReset, formatCompact, napLabel, spentLabel } from "@/shared/format";

/** The windows the HUD opens over the office; at most one is up at a time. */
export type Overlay = "ships" | "inbox" | "teams" | "budget" | "vercel" | "settings";

// ❗ stays, though VG5000 has no glyph for it and it renders as a colour emoji.
// Tried the pixel "!" — it reads as punctuation glued to the count and the plate
// loses its focal mark. The colour IS the signal here, so the fallback earns its keep.
const ALERT_GLYPH = "❗";
// ✉ not 📥: VG5000 has no inbox glyph, so it fell back to the system symbol
// font — the one icon here not drawn in the pixel font.
const INBOX_GLYPH = "✉";
// ◉ not ●: U+25CF isn't in VG5000 either, and this one has a pixel equivalent
// that reads as a status light.
const LIVE_GLYPH = "◉";

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
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-plate pointer-events-auto min-w-[64px] cursor-pointer px-3 py-1.5 text-center"
      title={title}
    >
      <div className="text-xs uppercase tracking-wide text-[#c3c9de]">{label}</div>
      <div
        className="text-base leading-tight tabular-nums"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </div>
      {sub ? <div className="text-xs tabular-nums text-[#a7adc6]">{sub}</div> : null}
    </button>
  );
}

/** Top-left: the money + adoption scoreboard — real numbers, or a nudge to connect. */
function Scoreboard({ company, onOpen }: { company: Company; onOpen: (overlay: Overlay) => void }) {
  const out = isOutOfBudget(company);
  const spent = spentLabel(company.spentUsd);
  return (
    <div className="pointer-events-none absolute top-3 left-3 z-10 flex items-stretch gap-2">
      <Stat
        label={company.revenueUsd !== null ? "revenue ⚡" : "revenue"}
        value={
          company.revenueUsd === null ? "—" : `$${formatCompact(Math.floor(company.revenueUsd))}`
        }
        accent={out ? "var(--danger)" : "#9fe6b0"}
        sub={company.revenueUsd === null ? `${spent} · connect` : `${spent}${out ? " · OUT" : ""}`}
        title="Real Stripe revenue vs real AI spend — budget & Stripe live here"
        onClick={() => onOpen("budget")}
      />
      <Stat
        label={company.users !== null ? "users ⚡" : "users"}
        value={company.users === null ? "—" : formatCompact(company.users)}
        accent="#86c0ee"
        sub={company.users === null ? "connect" : "web analytics"}
        title="Real users from Vercel Web Analytics on your deployed product"
        onClick={() => onOpen("vercel")}
      />
    </div>
  );
}

/**
 * What the product plate says: where the product really is. A live deploy or a
 * local entry the team wrote — never a number derived from how many tasks closed.
 */
function productStateOf(product: ProductStatus | null): string {
  const deploy = product?.deploy ?? null;
  if (deploy) return deploy.state === "READY" ? "LIVE" : deploy.state.toLowerCase();
  return product?.entry ? "local build" : "unshipped";
}

/** Top-right: the company — product state, team, and what's waiting on the founder. */
function CompanyPlates({
  company,
  employees,
  product,
  needsYou,
  nap,
  onOpen,
}: {
  company: Company;
  employees: Employee[];
  product: ProductStatus | null;
  needsYou: number;
  nap: string | null;
  onOpen: (overlay: Overlay) => void;
}) {
  const deploy = product?.deploy ?? null;
  const productState = productStateOf(product);
  const working = employees.filter((e) => e.status === "working").length;
  // a company has exactly one team, so a team count is a constant wearing a
  // number's clothes — the plate says what's actually happening instead
  const teamSub = working > 0 ? `${working} working` : (nap ?? "idle");
  return (
    <div className="pointer-events-none absolute top-3 right-3 z-10 flex items-stretch gap-2">
      <Stat
        label="product"
        value={productState}
        accent={productState === "LIVE" ? "var(--ok)" : undefined}
        sub={`${company.ships} shipped`}
        title={deploy ? `Live at ${deploy.url}` : "Shipping log"}
        onClick={() => onOpen("ships")}
      />
      <Stat
        label="team"
        value={String(employees.length)}
        sub={teamSub}
        title={
          nap
            ? "A CLI hit its usage limit — parked work resumes automatically at reset"
            : "The roster sizes itself — your lever is the budget"
        }
        onClick={() => onOpen("teams")}
      />
      <InboxButton needsYou={needsYou} onClick={() => onOpen("inbox")} />
    </div>
  );
}

function InboxButton({ needsYou, onClick }: { needsYou: number; onClick: () => void }) {
  const hasCount = needsYou > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-btn pointer-events-auto${hasCount ? "" : " px-btn-icon"}`}
      style={hasCount ? { background: "var(--warn)", color: "#3a2c0a" } : undefined}
      title="Questions, connect requests and stuck tasks waiting on you"
    >
      {hasCount ? (
        <span className="px-live-dot">
          <span className="px-icon">{ALERT_GLYPH}</span> {needsYou}
        </span>
      ) : (
        <span className="px-icon px-icon-solo">{INBOX_GLYPH}</span>
      )}
    </button>
  );
}

/** Bottom-left: start/pause the company, and settings. */
function RunControls({
  company,
  onOpen,
}: {
  company: Company;
  onOpen: (overlay: Overlay) => void;
}) {
  return (
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
            <span className="px-icon">{LIVE_GLYPH}</span> LIVE
          </>
        ) : (
          <>
            <span className="px-icon">▶</span> Start
          </>
        )}
      </button>
      <button
        type="button"
        onClick={() => onOpen("settings")}
        className="px-btn px-btn-icon pointer-events-auto"
        title="Settings"
      >
        <span className="px-icon px-icon-solo">⚙</span>
      </button>
    </div>
  );
}

/** Four-corner HUD; the bottom-right corner is the TeamChannel. */
export function Hud({ onOpen }: { onOpen: (overlay: Overlay) => void }) {
  const company = useStore((s) => s.company);
  const employees = useStore((s) => s.employees);
  const pendingAsks = useStore((s) => s.pendingAsks);
  const stuckTasks = useStore((s) => s.stuckTasks);
  const product = useStore((s) => s.product);
  const resting = useStore((s) => s.resting);
  const now = useNow();
  if (!company) return null;
  // a CLI on cooldown: the office naps until the earliest reset
  const until = earliestReset(resting, now);
  const nap = until === undefined ? null : napLabel(until);
  return (
    <>
      <Scoreboard company={company} onOpen={onOpen} />
      <CompanyPlates
        company={company}
        employees={employees}
        product={product}
        needsYou={pendingAsks.length + stuckTasks.length}
        nap={nap}
        onOpen={onOpen}
      />
      <RunControls company={company} onOpen={onOpen} />
    </>
  );
}
