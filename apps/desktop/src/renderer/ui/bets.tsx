import { killBet } from "@/renderer/state/store";
import { ConfirmLink } from "@/renderer/ui/confirm-link";
import { betGoal, betMoney, isClosed, isSpentOut, ledgerOrder } from "@/shared/bets";
import type { Bet } from "@/shared/bets";
import { formatDate, formatTime, formatUsd } from "@/shared/format";
import { cn } from "cn";

/** What the badge does not already say: how long is left, how far it moved, why it died. */
const verdictOf = (bet: Bet): string => {
  const st = bet.state;
  switch (st.kind) {
    case "open": {
      return isSpentOut(bet)
        ? "out of budget — the lead starts its clock or kills it"
        : `${formatUsd(bet.budgetUsd - bet.spentUsd)} left`;
    }
    case "measuring": {
      return `til ${formatDate(st.until)} ${formatTime(st.until)}`;
    }
    case "won": {
      return `moved ${st.moved}`;
    }
    case "killed": {
      return st.reason;
    }
    // no default
  }
};

const BetRow = ({ bet, onNote }: { bet: Bet; onNote: (note: string) => void }) => {
  const live = !isClosed(bet);
  return (
    <div className="px-inset p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm text-fg">🎲 {bet.title}</span>
        <span
          className={cn(
            "px-badge shrink-0",
            bet.state.kind === "won" || bet.state.kind === "open" ? "px-hot" : "px-quiet",
          )}
        >
          {bet.state.kind}
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-fg-dim">{bet.hypothesis}</p>
      <div className="mt-1 flex items-baseline justify-between gap-2 text-xs text-fg-dim">
        <span className="min-w-0 truncate" title={verdictOf(bet)}>
          {betGoal(bet)} · {betMoney(bet)} · {verdictOf(bet)}
        </span>
        {live ? (
          <ConfirmLink
            label="kill"
            confirmLabel="kill it"
            onConfirm={() => killBet(bet.id, "the founder called it")}
            onNote={onNote}
          />
        ) : null}
      </div>
    </div>
  );
};

/** Live bets first, then verdicts newest first. */
export const BetList = ({ bets, onNote }: { bets: Bet[]; onNote: (note: string) => void }) => {
  if (bets.length === 0) {
    return (
      <div className="text-sm text-fg-dim">
        No bets yet — with autopilot on, the lead opens the first one.
      </div>
    );
  }
  return ledgerOrder(bets).map((b) => <BetRow key={b.id} bet={b} onNote={onNote} />);
};
