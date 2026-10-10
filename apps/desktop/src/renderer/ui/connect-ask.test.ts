import { expect, it } from "vitest";
import type { StripeKeyStatus } from "@repo/domain/integrations";
import { connectAskCopy } from "./connect-ask";

const noKey: StripeKeyStatus = { state: "unset" };
const testKey: StripeKeyStatus = { last4: "4242", livemode: false, state: "set" };
const liveKey: StripeKeyStatus = { last4: "4242", livemode: true, state: "set" };

it("says a connection resumes the task while nothing in test mode would refuse it", () => {
  expect(connectAskCopy("stripe", liveKey)).toEqual({
    button: "Connect Stripe",
    resumes: "Their task resumes automatically once connected.",
  });
  expect(connectAskCopy("vercel", testKey).button).toBe("Connect Vercel");
  expect(connectAskCopy("stripe-key", noKey)).toEqual({
    button: "Add Stripe key",
    resumes: "Their task resumes automatically once the key is saved.",
  });
});

it("asks for a live key while the saved one is a test one, refused or not", () => {
  const copy = {
    button: "Replace Stripe key",
    resumes:
      "Stripe is in test mode, where no charge counts: their task resumes once a live key replaces the test one.",
  };
  expect(connectAskCopy("stripe", testKey)).toEqual(copy);
  expect(connectAskCopy("stripe", { ...testKey, state: "refused" })).toEqual(copy);
});
