import { useState } from "react";
import { useSubmission } from "@/renderer/hooks/use-submission";
import { Failure } from "@/renderer/ui/failure";
import {
  useStore,
  setBudget,
  resetSpend,
  connectStripe,
  disconnectStripe,
  saveStripeKey,
  removeStripeKey,
} from "@/renderer/state/store";
import { Modal } from "@/renderer/ui/modal";
import { Picker } from "@/renderer/ui/picker";
import type { PickerOption } from "@/renderer/ui/picker";
import { isOutOfBudget } from "@/shared/domain";
import type { Budget } from "@/shared/domain";
import { formatUsd } from "@/shared/format";
import type { StripeKeyStatus, StripeStatus } from "@/shared/integrations";

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

const ChargingKey = ({ stripeKey }: { stripeKey: StripeKeyStatus }) => {
  const [draft, setDraft] = useState("");
  const saving = useSubmission(async (key: string) => {
    await saveStripeKey(key);
    setDraft("");
  });
  const removing = useSubmission(removeStripeKey);
  if (stripeKey.state === "set") {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-fg">
          ✓ key …{stripeKey.last4}
          <span
            className="px-badge ml-2"
            style={{
              color: stripeKey.livemode ? "var(--ok)" : "var(--warn)",
            }}
          >
            {stripeKey.livemode ? "live" : "test"}
          </span>
        </span>
        <button
          type="button"
          onClick={() => removing.submit()}
          disabled={removing.submission.kind === "sending"}
          className="px-btn"
        >
          Remove
        </button>
        <Failure submission={removing.submission} doing="remove the key" />
      </div>
    );
  }
  const key = draft.trim();
  const sending = saving.submission.kind === "sending";
  return (
    <div>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="sk_… or rk_…"
          type="password"
          aria-label="Stripe secret key"
          className="px-field flex-1"
        />
        <button
          type="button"
          onClick={() => saving.submit(key)}
          disabled={sending || key.length === 0}
          className="px-btn-accent px-btn"
        >
          {sending ? "Checking…" : "Save"}
        </button>
      </div>
      <Failure submission={saving.submission} doing="save the key" />
    </div>
  );
};

export const BudgetModal = ({ onClose }: { onClose: () => void }) => {
  const company = useStore((s) => s.company);
  const stripeStatus = useStore((s) => s.stripeStatus);
  const stripeKey = useStore((s) => s.stripeKey);
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
              Connect your Stripe account to see your REAL revenue and customers
              {liveMetrics ? " — live now ⚡" : ""}.
            </div>
            <StripeConnection stripeStatus={stripeStatus} />
            <div className="pt-2 text-sm leading-snug text-fg">
              Charging key: lets the team create payment links, each one you sign off. Without
              Connect it also reads revenue, so a restricted key needs Read on Charges and Customers
              too.
            </div>
            <ChargingKey stripeKey={stripeKey} />
          </div>
        </div>
      </div>
    </Modal>
  );
};
