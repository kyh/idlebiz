import { useState } from "react";
import { killBet } from "@/renderer/state/store";
import { isClosed } from "@/shared/bets";
import type { Bet } from "@/shared/bets";
import { errorMessage } from "@/shared/errors";
import { formatDate, formatTime, formatUsd } from "@/shared/format";
import { cn } from "cn";

const goalOf = (bet: Bet): string =>
  bet.metric === "revenue" ? `+${formatUsd(bet.target)} revenue` : `+${bet.target} users`;

const verdictOf = (bet: Bet): string => {
  const st = bet.state;
  switch (st.kind) {
    case "open": {
      return "open";
    }
    case "measuring": {
      return `measuring til ${formatDate(st.until)} ${formatTime(st.until)}`;
    }
    case "won": {
      return `won · moved ${st.moved}`;
    }
    case "killed": {
      return `killed · ${st.reason}`;
    }
    // no default
  }
};

/** Asks twice: a killed bet cannot be reopened. */
const KillBet = ({ bet, onNote }: { bet: Bet; onNote: (note: string) => void }) => {
  const [arming, setArming] = useState(false);
  const kill = async () => {
    try {
      await killBet(bet.id, "the founder called it");
    } catch (error) {
      onNote(errorMessage(error));
    }
  };
  if (!arming) {
    return (
      <button type="button" onClick={() => setArming(true)} className="px-link px-link-danger">
        kill
      </button>
    );
  }
  return (
    <span className="flex gap-2">
      <button type="button" onClick={() => setArming(false)} className="px-link">
        keep
      </button>
      <button
        type="button"
        onClick={() => {
          void kill();
        }}
        className="px-link px-link-danger"
      >
        kill it
      </button>
    </span>
  );
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
          {goalOf(bet)} · {formatUsd(bet.spentUsd)} of {formatUsd(bet.budgetUsd)} · {verdictOf(bet)}
        </span>
        {live ? <KillBet bet={bet} onNote={onNote} /> : null}
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
  const live = bets.filter((b) => !isClosed(b));
  const closed = bets.filter(isClosed).toSorted((a, b) => b.state.closedAt - a.state.closedAt);
  return [...live, ...closed].map((b) => <BetRow key={b.id} bet={b} onNote={onNote} />);
};
