import { useEffect, useState } from "react";
import {
  useStore,
  setModalOpen,
  setBudget,
  resetSpend,
  connectStripe,
  disconnectStripe,
} from "@/renderer/state/store";
import { isOutOfBudget } from "@/shared/domain";

/** Budget control + Stripe connection: how much real money the office may burn,
 *  and where the real revenue/user numbers come from. */
export function BudgetModal({ onClose }: { onClose: () => void }) {
  const { company, stripeStatus, liveMetrics } = useStore();
  const [capInput, setCapInput] = useState("");

  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, []);

  useEffect(() => {
    if (company?.budget.mode === "capped") setCapInput(String(company.budget.capUsd));
  }, [company?.budget]);

  if (!company) return null;
  const capped = company.budget.mode === "capped";
  const out = isOutOfBudget(company);
  const parsedCap = Number.parseFloat(capInput);
  const capValid = Number.isFinite(parsedCap) && parsedCap >= 0;

  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-6">
      <div className="px-window flex max-h-[85vh] w-full max-w-xl flex-col">
        <div className="px-titlebar flex items-center justify-between px-4 py-2.5">
          <div>
            <div className="text-[16px]">Budget</div>
            <div className="text-[11px] text-[#c4c9dd]">
              AI tokens cost real money — set how much the office may burn
            </div>
          </div>
          <button onClick={onClose} className="px-btn text-[13px]">
            Done
          </button>
        </div>

        <div className="px-scroll flex-1 space-y-4 overflow-y-auto p-4">
          {out ? (
            <div
              className="px-inset p-3 text-[12px]"
              style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
            >
              ❗ Out of budget — autopilot is paused. Raise the cap (or go infinite) to get the team
              working again.
            </div>
          ) : null}

          <div>
            <div className="mb-2 text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
              Spending cap
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => void setBudget({ mode: "infinite" })}
                data-sel={!capped}
                className="px-opt text-[13px]"
              >
                ∞ Infinite
              </button>
              <button
                onClick={() => {
                  if (capValid) void setBudget({ mode: "capped", capUsd: parsedCap });
                }}
                data-sel={capped}
                className="px-opt text-[13px]"
              >
                $ Capped
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[13px] text-[var(--text)]">$</span>
              <input
                value={capInput}
                onChange={(e) => setCapInput(e.target.value)}
                placeholder="25"
                inputMode="decimal"
                className="px-field w-28 text-[13px]"
              />
              <button
                onClick={() => {
                  if (capValid) void setBudget({ mode: "capped", capUsd: parsedCap });
                }}
                disabled={!capValid}
                className="px-btn text-[12px]"
              >
                Set cap
              </button>
            </div>
          </div>

          <div className="px-inset flex items-center justify-between p-3">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
                Spent so far
              </div>
              <div className="text-[16px] text-[var(--text)]">${company.spentUsd.toFixed(2)}</div>
              {capped && company.budget.mode === "capped" ? (
                <div className="text-[10px] text-[var(--text-dim)]">
                  of ${company.budget.capUsd.toFixed(2)} budget
                </div>
              ) : null}
            </div>
            <button onClick={() => void resetSpend()} className="px-btn text-[12px]">
              Reset meter
            </button>
          </div>

          <div>
            <div className="mb-2 text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
              Real numbers · Stripe
            </div>
            <div className="px-inset space-y-2 p-3">
              <div className="text-[12px] leading-snug text-[var(--text)]">
                Connect your Stripe account and the dashboard shows REAL revenue (cash) and REAL
                customers (users){liveMetrics ? " — live now ⚡" : ""}.
              </div>
              {stripeStatus.state === "connected" ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] text-[var(--text)]">
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
                  <button onClick={() => void disconnectStripe()} className="px-btn text-[12px]">
                    Disconnect
                  </button>
                </div>
              ) : stripeStatus.state === "connecting" ? (
                <div className="px-live-dot text-[12px] text-[var(--text-dim)]">
                  Waiting for Stripe in your browser…
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  {stripeStatus.state === "error" ? (
                    <span className="text-[11px] text-[var(--danger)]">{stripeStatus.message}</span>
                  ) : (
                    <span className="text-[11px] text-[var(--text-dim)]">Not connected</span>
                  )}
                  <button
                    onClick={() => void connectStripe()}
                    className="px-btn-accent px-btn text-[12px]"
                  >
                    {stripeStatus.state === "error" ? "Reconnect Stripe" : "Connect Stripe"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
