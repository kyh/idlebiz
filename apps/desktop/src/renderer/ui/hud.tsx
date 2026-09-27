import type { ReactNode } from "react";
import { RUNNERS } from "@repo/agent-driver/registry";
import { linesOf, useAuthFlow } from "@/renderer/hooks/use-auth-flow";
import { useNow } from "@/renderer/hooks/use-now";
import { useSubmission } from "@/renderer/hooks/use-submission";
import type { Submission } from "@/renderer/hooks/use-submission";
import { Bust } from "@/renderer/ui/bust";
import { useStore, setAutopilot } from "@/renderer/state/store";
import { isOutOfBudget } from "@/shared/domain";
import type { Company, Employee, Product } from "@/shared/domain";
import { deploymentOf, productStateOf } from "@/renderer/ui/product-state";
import type { Overlay } from "@/renderer/ui/overlay";
import type { ProductStatus } from "@/shared/integrations";
import { earliestReset, formatCompact, napLabel, usageLabel } from "@/shared/format";
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
  const usage = usageLabel(company.spentUsd);
  return (
    <div className="pointer-events-none absolute top-3 left-3 z-10 flex items-stretch gap-2">
      <Stat
        label={company.revenueUsd === null ? "revenue" : "revenue ⚡"}
        value={
          company.revenueUsd === null ? "—" : `$${formatCompact(Math.floor(company.revenueUsd))}`
        }
        accent={out ? "var(--danger)" : "#9fe6b0"}
        sub={company.revenueUsd === null ? `${usage} · connect` : `${usage}${out ? " · OUT" : ""}`}
        title="Real Stripe revenue vs AI usage at API prices — budget & Stripe live here"
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
      title="Questions, steps only you can take and stuck tasks waiting on you"
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
  const deploy = deploymentOf(status);
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

const autopilotTitle = (company: Company, submission: Submission): string => {
  if (submission.kind === "failed") {
    return `Could not switch autopilot: ${submission.message}`;
  }
  return company.autopilot
    ? "Autopilot on — the company runs itself. Click to pause."
    : "Autopilot paused. Click to resume.";
};

const RunControls = ({
  company,
  onOpen,
}: {
  company: Company;
  onOpen: (overlay: Overlay) => void;
}) => {
  const { submission, submit } = useSubmission(setAutopilot);
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex items-stretch gap-2">
      <button
        type="button"
        onClick={() => submit(!company.autopilot)}
        disabled={submission.kind === "sending"}
        className={cn("px-btn pointer-events-auto", company.autopilot && "px-btn-live")}
        title={autopilotTitle(company, submission)}
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
      {submission.kind === "failed" ? (
        <div role="alert" className="px-inset px-hint px-hint-danger self-center px-2 py-1">
          {submission.message}
        </div>
      ) : null}
    </div>
  );
};

/** A runner signed out while another is still signed in: the gate never shows, so this is where it is signed in again. */
const SignedOutRunners = ({ company, employees }: { company: Company; employees: Employee[] }) => {
  const signedOut = useStore((s) => s.signedOut);
  const { auth, login } = useAuthFlow();
  const waiting = employees.filter((e) => signedOut.includes(e.runner));
  if (waiting.length === 0) {
    return null;
  }
  const runners = [...new Set(waiting.map((e) => RUNNERS[e.runner].displayName))].join(" and ");
  const leadWaits = waiting.some((e) => e.id === company.leaderId);
  const [line] = linesOf(auth).slice(-1);
  return (
    <div
      role="alert"
      className="px-inset pointer-events-auto absolute bottom-16 left-3 z-10 max-w-sm p-2 text-xs text-fg"
    >
      <div>
        {runners} is signed out, so{" "}
        {waiting.length === 1 ? "1 teammate waits" : `${waiting.length} teammates wait`} on it
        {leadWaits ? ", the lead among them: no bet is measured, killed or opened" : ""}. Sign in
        again to put them back to work.
      </div>
      {line === undefined ? null : <div className="mt-1 text-fg-dim">{line}</div>}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={login}
          disabled={auth.phase === "logging-in"}
          className="px-btn-accent px-btn"
        >
          {auth.phase === "logging-in" ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </div>
  );
};

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
      <SignedOutRunners company={company} employees={employees} />
      <RunControls
        key={isOutOfBudget(company) ? "out-of-budget" : "in-budget"}
        company={company}
        onOpen={onOpen}
      />
    </>
  );
};
