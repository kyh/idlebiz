import { INTEGRATION_LABELS } from "@repo/domain/domain";
import type { IntegrationKind } from "@repo/domain/domain";
import type { StripeKeyStatus } from "@repo/domain/integrations";

/** What an integration ask's card promises and what its button does. */
export interface ConnectAskCopy {
  button: string;
  resumes: string;
}

const stripeAskCopy = (stripeKey: StripeKeyStatus) => {
  if (stripeKey.state === "unset") {
    return {
      button: "Add Stripe key",
      resumes: "Their task resumes automatically once the key is saved.",
    } satisfies ConnectAskCopy;
  }

  if (!stripeKey.livemode) {
    return {
      button: "Replace Stripe key",
      resumes:
        "Stripe is in test mode, where no charge counts: their task resumes once a live key replaces the test one.",
    } satisfies ConnectAskCopy;
  }

  return {
    button: "Replace Stripe key",
    resumes:
      stripeKey.state === "refused"
        ? "Stripe turned the saved key away: their task resumes once a key it takes is saved."
        : "Their task resumes automatically once a key with what it needs is saved.",
  } satisfies ConnectAskCopy;
};

export const connectAskCopy = (integration: IntegrationKind, stripeKey: StripeKeyStatus) =>
  (integration === "stripe"
    ? stripeAskCopy(stripeKey)
    : {
        button: `Connect ${INTEGRATION_LABELS[integration]}`,
        resumes: "Their task resumes automatically once connected.",
      }) satisfies ConnectAskCopy;
