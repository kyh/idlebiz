import { useState } from "react";
import {
  useStore,
  setBudget,
  resetSpend,
  connectStripe,
  disconnectStripe,
} from "@/renderer/state/store";
import { Modal } from "@/renderer/ui/modal";
import { isOutOfBudget } from "@/shared/domain";
import { formatUsd } from "@/shared/format";

/** Budget control + Stripe connection: how much real money the office may burn,
 *  and where the real revenue/user numbers come from. */
export function BudgetModal({ onClose }: { onClose: () => void }) {
  const company = useStore((s) => s.company);
  const stripeStatus = useStore((s) => s.stripeStatus);
  const savedCap = company?.budget.mode === "capped" ? String(company.budget.capUsd) : "";
  // the draft carries the saved cap it was typed against, so a cap saved
  // elsewhere replaces a stale draft without an effect resetting it
  const [draft, setDraft] = useState({ savedCap, value: savedCap });
  const capInput = draft.savedCap === savedCap ? draft.value : savedCap;
  const setCapInput = (value: string) => setDraft({ savedCap, value });
  // real revenue showing at all means the connection is live
  const liveMetrics = company !== null && company.revenueUsd !== null;

  if (!company) return null;
  const budget = company.budget;
  const out = isOutOfBudget(company);
  const parsedCap = Number.parseFloat(capInput);
  const capValid = Number.isFinite(parsedCap) && parsedCap >= 0;
  const setCap = () => {
    if (capValid) void setBudget({ mode: "capped", capUsd: parsedCap });
  };

  return (
    <Modal
      title="Budget"
      subtitle="AI tokens cost real money — set how much the office may burn"
      onClose={onClose}
    >
      <div className="space-y-4">
        {out ? (
          <div
            className="px-inset p-3 text-sm"
            style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
          >
            ❗ Out of budget — autopilot is paused. Raise the cap (or go infinite) to get the team
            working again.
          </div>
        ) : null}

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-[var(--text-dim)]">
            Spending cap
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void setBudget({ mode: "infinite" })}
              data-sel={budget.mode === "infinite"}
              className="px-opt"
            >
              ∞ Infinite
            </button>
            <button
              type="button"
              onClick={setCap}
              data-sel={budget.mode === "capped"}
              className="px-opt"
            >
              $ Capped
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-sm text-[var(--text)]">$</span>
            <input
              value={capInput}
              onChange={(e) => setCapInput(e.target.value)}
              placeholder="25"
              inputMode="decimal"
              className="px-field w-28"
            />
            <button type="button" onClick={setCap} disabled={!capValid} className="px-btn">
              Set cap
            </button>
          </div>
        </div>

        <div className="px-inset flex items-center justify-between p-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-[var(--text-dim)]">
              Spent so far
            </div>
            <div className="text-base tabular-nums text-[var(--text)]">
              {formatUsd(company.spentUsd)}
            </div>
            {budget.mode === "capped" ? (
              <div className="text-xs tabular-nums text-[var(--text-dim)]">
                of {formatUsd(budget.capUsd)} budget
              </div>
            ) : null}
          </div>
          <button type="button" onClick={() => void resetSpend()} className="px-btn">
            Reset meter
          </button>
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-[var(--text-dim)]">
            Real numbers · Stripe
          </div>
          <div className="px-inset space-y-2 p-3">
            <div className="text-sm leading-snug text-[var(--text)]">
              Connect your Stripe account to see your REAL revenue and customers — there are no
              numbers without it{liveMetrics ? " — live now ⚡" : ""}.
            </div>
            {stripeStatus.state === "connected" ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-[var(--text)]">
                  ✓ {stripeStatus.accountId}
                  <span
                    className="px-badge ml-2"
                    style={{
                      color: stripeStatus.livemode ? "var(--ok)" : "var(--warn)",
                    }}
                  >
                    {stripeStatus.livemode ? "live" : "test"}
                  </span>
                </span>
                <button type="button" onClick={() => void disconnectStripe()} className="px-btn">
                  Disconnect
                </button>
              </div>
            ) : stripeStatus.state === "connecting" ? (
              <div className="px-live-dot text-sm text-[var(--text-dim)]">
                Waiting for Stripe in your browser…
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                {stripeStatus.state === "error" ? (
                  <span className="text-xs text-[var(--danger)]">{stripeStatus.message}</span>
                ) : (
                  <span className="text-xs text-[var(--text-dim)]">Not connected</span>
                )}
                <button
                  type="button"
                  onClick={() => void connectStripe()}
                  className="px-btn-accent px-btn"
                >
                  {stripeStatus.state === "error" ? "Reconnect Stripe" : "Connect Stripe"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
