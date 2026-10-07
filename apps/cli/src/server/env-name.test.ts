import { describe, expect, it } from "vitest";
import { isPublicEnvName, publicValueRefusal } from "./env-name";

const filler = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";

describe("a public env name", () => {
  it.each([
    ["NEXT_PUBLIC_STRIPE_KEY", true],
    ["VITE_STRIPE_KEY", true],
    ["PUBLIC_STRIPE_KEY", true],
    ["EXPO_PUBLIC_STRIPE_KEY", true],
    ["STRIPE_PUBLISHABLE_KEY", false],
    ["MY_NEXT_PUBLIC_KEY", false],
  ])("reads %s as built into the page: %s", (name, exposed) => {
    expect(isPublicEnvName(name)).toBe(exposed);
  });

  it.each([
    [`sk_live_${filler}`, "a Stripe secret or restricted key"],
    [`sk_org_live_${filler}`, "a Stripe secret or restricted key"],
    [`rk_live_${filler}`, "a Stripe secret or restricted key"],
    [`whsec_${filler}`, "a Stripe webhook signing secret"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn", "a private key"],
    ["-----BEGIN RSA PRIVATE KEY-----", "a private key"],
    [`ghp_${filler}`, "a GitHub token"],
    [`gho_${filler}`, "a GitHub token"],
    [`github_pat_${filler}`, "a GitHub token"],
    [`sk-ant-api03-${filler}`, "an Anthropic API key"],
    [`sk-proj-${filler}`, "an OpenAI API key"],
    ["AKIAIOSFODNN7EXAMPLE", "an AWS access key"],
    ["ASIAIOSFODNN7EXAMPLE", "an AWS access key"],
    [`re_${filler}`, "a Resend API key"],
    ["xoxb-1234567890-abcdefghij", "a Slack token"],
  ])("refuses %s under a public name", (value, what) => {
    const refused = publicValueRefusal("NEXT_PUBLIC_KEY", value);

    expect(refused).toContain(`that value looks like ${what}`);
    expect(refused).toContain("a NEXT_PUBLIC_ name is built into the page");
    expect(refused).toContain("server-only name");
    expect(refused).not.toContain(value);
  });

  it.each([
    `pk_live_${filler}`,
    `pk_test_${filler}`,
    "https://acme.dev",
    "G-ABC123XYZ9",
    `desk_${filler}`,
    `risk-${filler}`,
  ])("takes %s, which any visitor may read", (value) => {
    expect(publicValueRefusal("VITE_KEY", value)).toBeNull();
  });

  it("leaves a server-only name's value to the other checks", () => {
    expect(publicValueRefusal("STRIPE_WEBHOOK_SECRET", `whsec_${filler}`)).toBeNull();
  });
});
