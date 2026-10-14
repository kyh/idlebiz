import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, orpc } from "@/renderer/api";
import { useSubmission } from "@/renderer/hooks/use-submission";
import { useTransientNote } from "@/renderer/hooks/use-transient-note";
import { Failure } from "@/renderer/ui/failure";
import { queryClient, stripeKeyQuery, useCompany, useStripeKey } from "@/renderer/state/queries";
import { setBudget, resetSpend } from "@/renderer/state/store";
import { Modal } from "@/renderer/ui/modal";
import { Picker } from "@/renderer/ui/picker";
import type { PickerOption } from "@/renderer/ui/picker";
import { isOutOfBudget } from "@repo/domain/domain";
import type { Budget } from "@repo/domain/domain";
import { formatUsd } from "@repo/domain/format";
import { errorMessage } from "@repo/domain/errors";
import type { StripeKeyStatus } from "@repo/domain/integrations";
import { cn } from "cn";

const BUDGET_MODES: readonly PickerOption<Budget["mode"]>[] = [
  { label: "∞ Infinite", value: "infinite" },
  { label: "$ Capped", value: "capped" },
];

const REFUSED_KEY =
  "Stripe won't let this key read charges, so no revenue is counted — grant it Read on Charges, or paste a key over it.";

const stripeKeyMoved = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: stripeKeyQuery.queryKey });
};

const ChargingKey = ({ stripeKey }: { stripeKey: StripeKeyStatus }) => {
  const [draft, setDraft] = useState("");
  const saving = useSubmission(async (key: string) => {
    await api.stripe.saveKey({ key });
    await stripeKeyMoved();
    setDraft("");
  });
  const removing = useSubmission(async () => {
    await api.stripe.removeKey();
    await stripeKeyMoved();
  });
  const key = draft.trim();
  const sending = saving.submission.kind === "sending";
  const set = stripeKey.state !== "unset";
  const saveLabel = set ? "Replace key" : "Save";
  // a key is replaced by pasting over it, never by removing it first: a pulse in that gap finds
  // no key and hands every retiring link to the founder to switch off by hand
  const entry = (
    <div>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="sk_… or rk_…"
          type="password"
          aria-label={set ? "New Stripe secret key" : "Stripe secret key"}
          className="px-field flex-1"
        />
        <button
          type="button"
          onClick={() => saving.submit(key)}
          disabled={sending || key.length === 0}
          className="px-btn-accent px-btn"
        >
          {sending ? "Checking…" : saveLabel}
        </button>
      </div>
      <Failure submission={saving.submission} doing="save the key" />
    </div>
  );
  if (stripeKey.state === "unset") {
    return entry;
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-fg">
          {stripeKey.state === "refused" ? "✗" : "✓"} key …{stripeKey.last4}
          <span className={cn("px-badge ml-2", stripeKey.livemode ? "text-ok" : "text-warn")}>
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
      </div>
      {stripeKey.state === "refused" ? (
        <div role="alert" className="text-xs text-danger">
          {REFUSED_KEY}
        </div>
      ) : null}
      <Failure submission={removing.submission} doing="remove the key" />
      {entry}
    </div>
  );
};

const printfulToken = orpc.printful.tokenStatus.queryOptions();

const printfulTokenMoved = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: printfulToken.queryKey });
};

const PrintfulToken = () => {
  const { data: status, error } = useQuery(printfulToken);
  const [draft, setDraft] = useState("");
  const saving = useSubmission(async (token: string) => {
    await api.printful.saveToken({ token });
    setDraft("");
    await printfulTokenMoved();
  });
  const removing = useSubmission(async () => {
    await api.printful.removeToken();
    await printfulTokenMoved();
  });
  if (status === undefined) {
    return error === null ? null : (
      <div role="alert" className="text-xs text-danger">
        Could not read the Printful token: {errorMessage(error)}
      </div>
    );
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
  const company = useCompany();
  const stripeKey = useStripeKey();
  const savedCap = company?.budget.mode === "capped" ? String(company.budget.capUsd) : "";
  // the draft carries the saved cap it was typed against, so a cap saved
  // elsewhere replaces a stale draft without an effect resetting it
  const [draft, setDraft] = useState({ savedCap, value: savedCap });
  const capInput = draft.savedCap === savedCap ? draft.value : savedCap;
  const setCapInput = (value: string) => setDraft({ savedCap, value });
  // real revenue showing at all means the key reads it
  const liveMetrics = company !== null && company.revenueUsd !== null;
  const saving = useSubmission(setBudget);
  const resetting = useSubmission(resetSpend);
  const capField = useRef<HTMLInputElement>(null);
  const [capNote, showCapNote] = useTransientNote(2500);

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
          <div className="px-inset px-inset-danger p-3 text-sm text-danger">
            ❗ Out of budget — autopilot is paused. Raise the cap (or go infinite), then press ▶
            Start to get the team working again.
          </div>
        ) : null}

        <div>
          <div className="px-label mb-2 text-fg-dim">Usage cap</div>
          <Picker
            options={BUDGET_MODES}
            value={budget.mode}
            onChange={(mode) => {
              if (mode === "infinite") {
                saving.submit({ mode });
              } else if (capValid) {
                setCap();
              } else {
                capField.current?.focus();
                showCapNote("Type a cap, then Set cap.");
              }
            }}
            label="Usage cap"
            className="grid grid-cols-2 gap-2"
            disabled={saving.submission.kind === "sending"}
          />
          <div className="mt-2 flex items-center gap-2">
            <span className="text-sm text-fg">$</span>
            <input
              ref={capField}
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
          {capNote ? <div className="mt-1 text-xs text-fg-dim">{capNote}</div> : null}
          <Failure submission={saving.submission} doing="save the budget" />
        </div>

        <div className="px-inset flex items-center justify-between p-3">
          <div>
            <div className="px-label text-fg-dim">Usage (at API prices)</div>
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
          <div className="px-label mb-2 text-fg-dim">Real numbers · Stripe</div>
          <div className="px-inset space-y-2 p-3">
            <div className="text-sm leading-snug text-fg">
              Your Stripe key lets the team create payment links, each one you sign off, and reads
              the REAL revenue they bring in{liveMetrics ? " — live now ⚡" : ""}, so a restricted
              key needs Read on Charges too. Read on Checkout Sessions is how paid orders are found,
              so a link that names a delivery needs it, and selling prints needs it with Write on
              Shipping Rates.
            </div>
            <ChargingKey stripeKey={stripeKey} />
          </div>
        </div>

        <div>
          <div className="px-label mb-2 text-fg-dim">Print on demand · Printful</div>
          <div className="px-inset space-y-2 p-3">
            <div className="text-sm leading-snug text-fg">
              A private token lets the team sell printed goods, each listing you sign off. IdleBiz
              sends each paid order to Printful, which prints, ships and bills it to your Printful
              account; one that costs more than the buyer paid, or goes wrong, lands in your inbox.
              Make one at developers.printful.com/tokens for a single store, with View and manage
              orders.
            </div>
            <PrintfulToken />
          </div>
        </div>
      </div>
    </Modal>
  );
};
