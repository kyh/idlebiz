import { useState } from "react";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
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
import type { StripeStatus } from "@/shared/ipc-registry";

const StripeConnection = ({ stripeStatus }: { stripeStatus: StripeStatus }) => {
  if (stripeStatus.state === "connected") {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-fg">
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
        <button
          type="button"
          onClick={() => {
            void disconnectStripe();
          }}
          className="px-btn"
        >
          Disconnect
        </button>
      </div>
    );
  }
  if (stripeStatus.state === "connecting") {
    return (
      <div className="px-live-dot text-sm text-fg-dim">Waiting for Stripe in your browser…</div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2">
      {stripeStatus.state === "error" ? (
        <span className="text-xs text-danger">{stripeStatus.message}</span>
      ) : (
        <span className="text-xs text-fg-dim">Not connected</span>
      )}
      <button
        type="button"
        onClick={() => {
          void connectStripe();
        }}
        className="px-btn-accent px-btn"
      >
        {stripeStatus.state === "error" ? "Reconnect Stripe" : "Connect Stripe"}
      </button>
    </div>
  );
};

export const BudgetModal = ({ onClose }: { onClose: () => void }) => {
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

  if (!company) {
    return null;
  }
  const { budget } = company;
  const out = isOutOfBudget(company);
  const parsedCap = Number(capInput);
  const capValid = capInput.trim() !== "" && Number.isFinite(parsedCap) && parsedCap >= 0;
  const setCap = () => {
    if (capValid) {
      void setBudget({ capUsd: parsedCap, mode: "capped" });
    }
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
            style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
          >
            ❗ Out of budget — autopilot is paused. Raise the cap (or go infinite) to get the team
            working again.
          </div>
        ) : null}

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-fg-dim">Spending cap</div>
          <ToggleGroup
            value={[budget.mode]}
            onValueChange={([mode]) => {
              if (mode === "infinite") {
                void setBudget({ mode: "infinite" });
              } else if (mode === "capped") {
                setCap();
              }
            }}
            aria-label="Spending cap"
            className="grid grid-cols-2 gap-2"
          >
            <Toggle value="infinite" className="px-opt">
              ∞ Infinite
            </Toggle>
            <Toggle value="capped" className="px-opt">
              $ Capped
            </Toggle>
          </ToggleGroup>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-sm text-fg">$</span>
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
            <div className="text-xs uppercase tracking-wide text-fg-dim">Spent so far</div>
            <div className="text-base tabular-nums text-fg">{formatUsd(company.spentUsd)}</div>
            {budget.mode === "capped" ? (
              <div className="text-xs tabular-nums text-fg-dim">
                of {formatUsd(budget.capUsd)} budget
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => {
              void resetSpend();
            }}
            className="px-btn"
          >
            Reset meter
          </button>
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-fg-dim">
            Real numbers · Stripe
          </div>
          <div className="px-inset space-y-2 p-3">
            <div className="text-sm leading-snug text-fg">
              Connect your Stripe account to see your REAL revenue and customers — there are no
              numbers without it{liveMetrics ? " — live now ⚡" : ""}.
            </div>
            <StripeConnection stripeStatus={stripeStatus} />
          </div>
        </div>
      </div>
    </Modal>
  );
};
