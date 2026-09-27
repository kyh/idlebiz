import { INTEGRATION_LABELS } from "@/shared/domain";
import type { IntegrationNeed } from "@/shared/domain";
import type { StripeKeyStatus, StripeStatus } from "@/shared/integrations";

/** What an integration ask's card promises and what its button does. */
export interface ConnectAskCopy {
  button: string;
  resumes: string;
}

/**
 * Main resumes no Stripe ask while either key is in test mode, so a card promising the task
 * resumes on connecting would stay up after the founder did.
 */
export const connectAskCopy = (
  integration: IntegrationNeed,
  stripeKey: StripeKeyStatus,
  stripeStatus: StripeStatus,
): ConnectAskCopy => {
  if (integration === "stripe-key") {
    // only a saved key charges: a Stripe connection reads revenue, so the card says to add one
    return {
      button: "Add Stripe key",
      resumes: "Their task resumes automatically once the key is saved.",
    };
  }
  if (integration === "stripe" && stripeKey.state === "set" && !stripeKey.livemode) {
    return {
      button: "Replace Stripe key",
      resumes:
        "Stripe is in test mode, where no charge counts: their task resumes once a live key replaces the test one.",
    };
  }
  if (integration === "stripe" && stripeStatus.state === "connected" && !stripeStatus.livemode) {
    return {
      button: "Reconnect Stripe",
      resumes:
        "Stripe is connected in test mode, where no charge counts: their task resumes once it is connected live.",
    };
  }
  return {
    button: `Connect ${INTEGRATION_LABELS[integration]}`,
    resumes: "Their task resumes automatically once connected.",
  };
};
