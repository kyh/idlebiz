import { useState } from "react";
import { useSubmission } from "@/renderer/hooks/use-submission";
import { Failure } from "@/renderer/ui/failure";
import {
  useStore,
  setBudget,
  resetSpend,
  connectStripe,
  disconnectStripe,
} from "@/renderer/state/store";
import { Modal } from "@/renderer/ui/modal";
import { Picker } from "@/renderer/ui/picker";
import type { PickerOption } from "@/renderer/ui/picker";
import { isOutOfBudget } from "@/shared/domain";
import type { Budget } from "@/shared/domain";
import { formatUsd } from "@/shared/format";
import type { StripeStatus } from "@/shared/ipc-registry";

const BUDGET_MODES: readonly PickerOption<Budget["mode"]>[] = [
  { label: "∞ Infinite", value: "infinite" },
  { label: "$ Capped", value: "capped" },
];

const StripeConnection = ({ stripeStatus }: { stripeStatus: StripeStatus }) => {
  const connecting = useSubmission(connectStripe);
  const disconnecting = useSubmission(disconnectStripe);
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
          onClick={() => disconnecting.submit()}
          disabled={disconnecting.submission.kind === "sending"}
          className="px-btn"
        >
          Disconnect
        </button>
        <Failure submission={disconnecting.submission} doing="disconnect" />
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
        onClick={() => connecting.submit()}
        disabled={connecting.submission.kind === "sending"}
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
  const saving = useSubmission(setBudget);
  const resetting = useSubmission(resetSpend);

  if (!company) {
    return null;
  }
  const { budget } = company;
  const out = isOutOfBudget(company);
  const parsedCap = Number(capInput);
  const capValid = capInput.trim() !== "" && Number.isFinite(parsedCap) && parsedCap >= 0;
  const setCap = () => {
    if (capValid) {
      saving.submit({ capUsd: parsedCap, mode: "capped" });
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
          <Picker
            options={BUDGET_MODES}
            value={budget.mode}
            onChange={(mode) => {
              if (mode === "infinite") {
                saving.submit({ mode });
              } else {
                setCap();
              }
            }}
            label="Spending cap"
            className="grid grid-cols-2 gap-2"
          />
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
          <Failure submission={saving.submission} doing="save the budget" />
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
            onClick={() => resetting.submit()}
            disabled={resetting.submission.kind === "sending"}
            className="px-btn"
          >
            Reset meter
          </button>
        </div>
        <Failure submission={resetting.submission} doing="reset the meter" />

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
