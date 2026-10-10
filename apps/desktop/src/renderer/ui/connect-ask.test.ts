import { expect, it } from "vitest";
import type { StripeKeyStatus } from "@repo/domain/integrations";
import { connectAskCopy } from "./connect-ask";

const noKey: StripeKeyStatus = { state: "unset" };
const testKey: StripeKeyStatus = { last4: "4242", livemode: false, state: "set" };
const liveKey: StripeKeyStatus = { last4: "4242", livemode: true, state: "set" };

it("says a connection resumes the task, and a Stripe ask once a key is saved", () => {
  expect(connectAskCopy("vercel", testKey)).toEqual({
    button: "Connect Vercel",
    resumes: "Their task resumes automatically once connected.",
  });
  expect(connectAskCopy("stripe", noKey)).toEqual({
    button: "Add Stripe key",
    resumes: "Their task resumes automatically once the key is saved.",
  });
  expect(connectAskCopy("stripe", liveKey)).toEqual({
    button: "Replace Stripe key",
    resumes: "Their task resumes automatically once a key with what it needs is saved.",
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

it("says Stripe turned away a live key it refused", () => {
  expect(connectAskCopy("stripe", { ...liveKey, state: "refused" })).toEqual({
    button: "Replace Stripe key",
    resumes: "Stripe turned the saved key away: their task resumes once a key it takes is saved.",
  });
});
