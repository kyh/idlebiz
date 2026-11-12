// What the approval card says about a signed tool's call, by the rule that held it.
// Data only, so the renderer names a hold without bundling the tool that raised it.

/** Every rule that holds a signed tool's call for the founder. A saved ask names one, so retiring one breaks the saves still asking under it. */
export const HOLD_RULE_IDS = ["deploy", "payments"] as const;

export type HoldRuleId = (typeof HOLD_RULE_IDS)[number];

const HOLD_RULES = {
  deploy: "Deploy the product to a live, public URL.",
  payments: "Move real money or change records in your Stripe account.",
} satisfies Record<HoldRuleId, string>;

/** What the founder signs for by approving: exactly the action shown, once. */
export const APPROVAL_SCOPE = "Approving covers exactly this, once.";

/** What the card says a held ask's rule holds. */
export const describeRule = (rule: HoldRuleId): string => HOLD_RULES[rule];

// A direction override or a zero-width character in the key would let the card show one
// command while the founder signs another, so each is shown by its code point. A newline
// starts another command, so it shows as a mark that a literal one cannot fake, then a break.
const HIDDEN = /[\p{Cc}\p{Cf}⏎]/gu;

/** A held ask's key as its card shows it: every control or format character named, none obeyed. */
export const shownKey = (key: string): string =>
  key.replaceAll(HIDDEN, (char) =>
    char === "\n"
      ? "⏎\n"
      : `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`,
  );
