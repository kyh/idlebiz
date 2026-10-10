import { INTEGRATION_LABELS } from "@repo/domain/domain";
import type { IntegrationNeed } from "@repo/domain/domain";
import type { StripeKeyStatus } from "@repo/domain/integrations";

/** What an integration ask's card promises and what its button does. */
export interface ConnectAskCopy {
  button: string;
  resumes: string;
}

/**
 * Main resumes no Stripe ask while the key is in test mode, so a card promising the task
 * resumes on saving one would stay up after the founder did.
 */
export const connectAskCopy = (
  integration: IntegrationNeed,
  stripeKey: StripeKeyStatus,
): ConnectAskCopy => {
  if (integration === "stripe-key") {
    return {
      button: "Add Stripe key",
      resumes: "Their task resumes automatically once the key is saved.",
    };
  }
  if (integration === "stripe" && stripeKey.state !== "unset" && !stripeKey.livemode) {
    return {
      button: "Replace Stripe key",
      resumes:
        "Stripe is in test mode, where no charge counts: their task resumes once a live key replaces the test one.",
    };
  }
  return {
    button: `Connect ${INTEGRATION_LABELS[integration]}`,
    resumes: "Their task resumes automatically once connected.",
  };
};
