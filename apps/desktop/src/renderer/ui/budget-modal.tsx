import { useState } from "react";
import { bridge } from "@/renderer/bridge";
import { useAsync } from "@/renderer/hooks/use-async";
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
import type { PrintfulTokenStatus, StripeKeyStatus, StripeStatus } from "@/shared/integrations";

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

const PrintfulToken = () => {
  const read = useAsync(() => bridge().printfulTokenStatus(), []);
  const [answered, setAnswered] = useState<PrintfulTokenStatus | null>(null);
  const [draft, setDraft] = useState("");
  const saving = useSubmission(async (token: string) => {
    await bridge().printfulTokenSave({ token });
    setDraft("");
    setAnswered(await bridge().printfulTokenStatus());
  });
  const removing = useSubmission(async () => {
    await bridge().printfulTokenRemove();
    setAnswered(await bridge().printfulTokenStatus());
  });
  const status = answered ?? (read.kind === "ready" ? read.value : null);
  if (read.kind === "failed" && answered === null) {
    return (
      <div role="alert" className="text-xs text-danger">
        Could not read the Printful token: {read.message}
      </div>
    );
  }
  if (status === null) {
    return null;
  }
  const token = draft.trim();
  const sending = saving.submission.kind === "sending";
  const set = status.state === "set";
  const saveLabel = set ? "Replace token" : "Save token";
  // Printful's tokens expire, and a card about one it turned away opens this panel while the
  // dead token still reads as saved, so a new one can always be pasted over it
  const entry = (
    <div>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={set ? "New private token" : "Private token"}
          type="password"
          aria-label={set ? "New Printful private token" : "Printful private token"}
          className="px-field flex-1"
        />
        <button
          type="button"
          onClick={() => saving.submit(token)}
          disabled={sending || token.length === 0}
          className="px-btn-accent px-btn"
        >
          {sending ? "Checking…" : saveLabel}
        </button>
      </div>
      <Failure submission={saving.submission} doing="save the token" />
    </div>
  );
  if (!set) {
    return entry;
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-fg">
          ✓ token …{status.last4} · {status.store}
        </span>
        <button
          type="button"
          onClick={() => removing.submit()}
          disabled={removing.submission.kind === "sending"}
          className="px-btn"
        >
          Remove token
        </button>
      </div>
      <Failure submission={removing.submission} doing="remove the token" />
      {entry}
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
      subtitle="Every run is metered at API prices, whatever your plan bills — cap how much the office uses"
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
          <div className="mb-2 text-xs uppercase tracking-wide text-fg-dim">Usage cap</div>
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
            label="Usage cap"
            className="grid grid-cols-2 gap-2"
            disabled={saving.submission.kind === "sending"}
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
            <button
              type="button"
              onClick={setCap}
              disabled={!capValid || saving.submission.kind === "sending"}
              className="px-btn"
            >
              Set cap
            </button>
          </div>
          <Failure submission={saving.submission} doing="save the budget" />
        </div>

        <div className="px-inset flex items-center justify-between p-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-fg-dim">Usage (at API prices)</div>
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

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-fg-dim">
            Print on demand · Printful
          </div>
          <div className="px-inset space-y-2 p-3">
            <div className="text-sm leading-snug text-fg">
              A private token lets the team sell printed goods, each listing you sign off, printed
              by Printful and billed to your Printful account. Paid orders are not sent to Printful
              yet, so listings are made only on a test-mode Stripe key. Make one at
              developers.printful.com/tokens for a single store, with View and manage orders.
            </div>
            <PrintfulToken />
          </div>
        </div>
      </div>
    </Modal>
  );
};
