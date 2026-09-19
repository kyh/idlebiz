import type { ReactNode } from "react";
import { useNow } from "@/renderer/hooks/use-now";
import { Bust } from "@/renderer/ui/bust";
import { useStore, setAutopilot } from "@/renderer/state/store";
import { isOutOfBudget } from "@/shared/domain";
import type { Company, Employee, Product } from "@/shared/domain";
import { productStateOf } from "@/renderer/ui/product-state";
import type { Overlay } from "@/renderer/ui/overlay";
import type { ProductStatus } from "@/shared/ipc-registry";
import { earliestReset, formatCompact, napLabel, spentLabel } from "@/shared/format";
import { cn } from "cn";

// VG5000 has no alert glyph; the colored emoji is intentional.
const ALERT_GLYPH = "❗";
// These glyphs exist in VG5000; 📥 and ● would use a fallback font.
const INBOX_GLYPH = "✉";
const LIVE_GLYPH = "◉";

const Stat = ({
  label,
  value,
  sub,
  accent,
  title,
  face,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  title?: string;
  /** A bust beside the figures, for a plate that is about a person. */
  face?: ReactNode;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="px-plate pointer-events-auto flex min-w-[64px] cursor-pointer items-center gap-2 px-3 py-1.5 text-center"
    title={title}
  >
    {face}
    <span className="block flex-1">
      <span className="block text-xs uppercase tracking-wide text-[#c3c9de]">{label}</span>
      <span
        className="block text-base leading-tight tabular-nums"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </span>
      {sub ? <span className="block text-xs tabular-nums text-[#a7adc6]">{sub}</span> : null}
    </span>
  </button>
);

const Scoreboard = ({
  company,
  onOpen,
}: {
  company: Company;
  onOpen: (overlay: Overlay) => void;
}) => {
  const out = isOutOfBudget(company);
  const spent = spentLabel(company.spentUsd);
  return (
    <div className="pointer-events-none absolute top-3 left-3 z-10 flex items-stretch gap-2">
      <Stat
        label={company.revenueUsd === null ? "revenue" : "revenue ⚡"}
        value={
          company.revenueUsd === null ? "—" : `$${formatCompact(Math.floor(company.revenueUsd))}`
        }
        accent={out ? "var(--danger)" : "#9fe6b0"}
        sub={company.revenueUsd === null ? `${spent} · connect` : `${spent}${out ? " · OUT" : ""}`}
        title="Real Stripe revenue vs real AI spend — budget & Stripe live here"
        onClick={() => onOpen({ kind: "budget" })}
      />
      <Stat
        label={company.users === null ? "users" : "users ⚡"}
        value={company.users === null ? "—" : formatCompact(company.users)}
        accent="#86c0ee"
        sub={company.users === null ? "connect" : "web analytics"}
        title="Real users from Vercel Web Analytics on your deployed product"
        onClick={() => onOpen({ kind: "ships" })}
      />
    </div>
  );
};
const InboxButton = ({ needsYou, onClick }: { needsYou: number; onClick: () => void }) => {
  const hasCount = needsYou > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("px-btn pointer-events-auto", hasCount ? "px-hot" : "px-btn-icon")}
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
};

const CompanyPlates = ({
  company,
  employees,
  products,
  productStatus,
  needsYou,
  nap,
  onOpen,
}: {
  company: Company;
  employees: Employee[];
  products: Product[];
  productStatus: ReadonlyMap<string, ProductStatus>;
  needsYou: number;
  nap: string | null;
  onOpen: (overlay: Overlay) => void;
}) => {
  // the plate shows the company's first product; the panel behind it shows them all
  const [lead] = products;
  const status = lead ? productStatus.get(lead.id) : undefined;
  const deploy = status?.deploy ?? null;
  const productState = productStateOf(status);
  const portfolio = products.length > 1 ? ` · ${products.length} products` : "";
  const working = employees.filter((e) => e.status === "working").length;
  const teamSub = working > 0 ? `${working} working` : (nap ?? "idle");
  const leader = employees.find((e) => e.id === company.leaderId);
  return (
    <div className="pointer-events-none absolute top-3 right-3 z-10 flex items-stretch gap-2">
      <Stat
        label={lead && products.length > 1 ? lead.name : "product"}
        value={productState}
        accent={productState === "LIVE" ? "var(--ok)" : undefined}
        sub={`${company.ships} shipped${portfolio}`}
        title={deploy ? `Live at ${deploy.url}` : "Products and the shipping log"}
        onClick={() => onOpen({ kind: "ships" })}
      />
      <Stat
        label="team"
        value={String(employees.length)}
        sub={teamSub}
        face={leader ? <Bust seed={leader.spriteSeed} size="sm" alt="" /> : undefined}
        title={
          nap
            ? "A CLI hit its usage limit — parked work resumes automatically at reset"
            : "The roster sizes itself — your lever is the budget"
        }
        onClick={() => onOpen({ kind: "teams" })}
      />
      <InboxButton needsYou={needsYou} onClick={() => onOpen({ kind: "inbox" })} />
    </div>
  );
};

const RunControls = ({
  company,
  onOpen,
}: {
  company: Company;
  onOpen: (overlay: Overlay) => void;
}) => (
  <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex items-stretch gap-2">
    <button
      type="button"
      onClick={() => {
        void setAutopilot(!company.autopilot);
      }}
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
      onClick={() => onOpen({ kind: "settings" })}
      className="px-btn px-btn-icon pointer-events-auto"
      title="Settings"
    >
      <span className="px-icon px-icon-solo">⚙</span>
    </button>
  </div>
);

export const Hud = ({ onOpen }: { onOpen: (overlay: Overlay) => void }) => {
  const company = useStore((s) => s.company);
  const employees = useStore((s) => s.employees);
  const pendingAsks = useStore((s) => s.pendingAsks);
  const stuckTasks = useStore((s) => s.stuckTasks);
  const products = useStore((s) => s.products);
  const productStatus = useStore((s) => s.productStatus);
  const resting = useStore((s) => s.resting);
  const now = useNow();
  if (!company) {
    return null;
  }
  // a CLI on cooldown: the office naps until the earliest reset
  const until = earliestReset(resting, now);
  const nap = until === undefined ? null : napLabel(until);
  return (
    <>
      <Scoreboard company={company} onOpen={onOpen} />
      <CompanyPlates
        company={company}
        employees={employees}
        products={products}
        productStatus={productStatus}
        needsYou={pendingAsks.length + stuckTasks.length}
        nap={nap}
        onOpen={onOpen}
      />
      <RunControls company={company} onOpen={onOpen} />
    </>
  );
};
