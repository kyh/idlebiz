import { expect, it } from "vitest";
import type { StripeKeyStatus, StripeStatus } from "@/shared/integrations";
import { connectAskCopy } from "./connect-ask";

const disconnected: StripeStatus = { state: "disconnected" };
const noKey: StripeKeyStatus = { state: "unset" };
const testKey: StripeKeyStatus = { last4: "4242", livemode: false, state: "set" };
const liveKey: StripeKeyStatus = { last4: "4242", livemode: true, state: "set" };

it("says a connection resumes the task while nothing in test mode would refuse it", () => {
  expect(connectAskCopy("stripe", liveKey, disconnected)).toEqual({
    button: "Connect Stripe",
    resumes: "Their task resumes automatically once connected.",
  });
  expect(connectAskCopy("vercel", testKey, disconnected).button).toBe("Connect Vercel");
  expect(connectAskCopy("stripe-key", noKey, disconnected)).toEqual({
    button: "Add Stripe key",
    resumes: "Their task resumes automatically once the key is saved.",
  });
});

it("asks for a live key, not a connection, while the charging key is a test one", () => {
  const live: StripeStatus = { accountId: "acct_1", livemode: true, state: "connected" };
  expect(connectAskCopy("stripe", testKey, live)).toEqual({
    button: "Replace Stripe key",
    resumes:
      "Stripe is in test mode, where no charge counts: their task resumes once a live key replaces the test one.",
  });
});

it("asks for a live connection while Stripe is connected in test mode", () => {
  const test: StripeStatus = { accountId: "acct_1", livemode: false, state: "connected" };
  expect(connectAskCopy("stripe", liveKey, test)).toEqual({
    button: "Reconnect Stripe",
    resumes:
      "Stripe is connected in test mode, where no charge counts: their task resumes once it is connected live.",
  });
});
