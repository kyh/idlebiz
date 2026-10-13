import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefusalError } from "./refusal";
import { getSecret, setSealer, setSecret } from "./secrets";
import { noteStripeRead, removeStripeKey, saveStripeKey, stripeKeyStatus } from "./stripe-key";
import { fetchRealMetrics, stripeCredential } from "./metrics";
import type { StripeAnswer } from "./metrics";
import { tempSave } from "./test-support/save";

const root = tempSave();

const secretsFile = path.join(root, "secrets.json");

beforeEach(() => {
  rmSync(secretsFile, { force: true });
  // a stand-in for the Keychain: it only has to keep the key out of the file
  setSealer({
    open: (sealed) => Buffer.from(sealed.toReversed()).toString("utf-8"),
    seal: (plain) => Buffer.from(Buffer.from(plain, "utf-8").toReversed()),
  });
});

afterEach(() => {
  setSealer(null);
});

/** Stripe answering every call with `answer`; keeps what each call asked for, and with which key. */
const stripe = (answer: (url: string) => Promise<Response>) => {
  const asked: { url: string; auth: string | null; method: string }[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    asked.push({
      auth: new Headers(init?.headers).get("authorization"),
      method: init?.method ?? "GET",
      url,
    });
    return answer(url);
  });
  return asked;
};

/** The metrics pulse's read of the saved key, noted as the pulse notes it. */
const pulse = async (): Promise<StripeAnswer> => {
  const key = stripeCredential();
  const read = await fetchRealMetrics(key, [], []);
  if (key === null || read.stripe === null) {
    throw new Error("the saved key was not read");
  }
  noteStripeRead(key, read.stripe);
  return read.stripe;
};

const listed = () => Promise.resolve(Response.json({ data: [], has_more: false, object: "list" }));
const refused = (status: number) => () =>
  Promise.resolve(
    Response.json({ error: { message: "no", type: "invalid_request_error" } }, { status }),
  );

describe("saving the charging key", () => {
  it("keeps a key Stripe takes, sealed, and tells the renderer only its last four and mode", async () => {
    const asked = stripe(listed);

    await saveStripeKey("sk_live_founder1234");

    expect(asked).toEqual([
      {
        auth: "Bearer sk_live_founder1234",
        method: "GET",
        url: "https://api.stripe.com/v1/payment_links?limit=1",
      },
    ]);
    expect(readFileSync(secretsFile, "utf-8")).not.toContain("sk_live_founder1234");
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("sk_live_founder1234");
    expect(stripeKeyStatus()).toEqual({ last4: "1234", livemode: true, state: "set" });
  });

  it("reads test mode off a secret or restricted key", async () => {
    stripe(listed);

    await saveStripeKey("rk_test_restricted9876");
    expect(stripeKeyStatus()).toEqual({ last4: "9876", livemode: false, state: "set" });

    await saveStripeKey("sk_test_founder5555");
    expect(stripeKeyStatus()).toEqual({ last4: "5555", livemode: false, state: "set" });
  });

  it.each([
    { said: "doesn't recognise this key", status: 401, why: "a key Stripe doesn't know" },
    {
      said: "won't let this key make payment links",
      status: 403,
      why: "a restricted key that can't make payment links",
    },
    {
      said: "Stripe couldn't check this key (no)",
      status: 500,
      why: "a key Stripe couldn't check",
    },
  ])("refuses $why, keeping the key saved before", async ({ said, status }) => {
    stripe(listed);
    await saveStripeKey("sk_live_saved0001");
    stripe(refused(status));

    const saving = saveStripeKey("sk_live_mistyped0002");

    await expect(saving).rejects.toThrow(RefusalError);
    await expect(saving).rejects.toThrow(said);
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("sk_live_saved0001");
  });

  it("refuses a key while Stripe is out of reach, saving nothing", async () => {
    stripe(() => Promise.reject(new TypeError("fetch failed")));

    await expect(saveStripeKey("sk_live_founder1234")).rejects.toThrow(
      "Stripe couldn't check this key (fetch failed) — nothing was saved; try again.",
    );
    expect(stripeKeyStatus()).toEqual({ state: "unset" });
  });

  it.each([
    { key: "pk_live_publishable1234", what: "a publishable key" },
    { key: "whsec_signing1234", what: "a webhook secret" },
    { key: "sk_live_", what: "a key cut short" },
    { key: "sk_live_abc​def", what: "a key with an invisible character" },
    { key: "sk_live_abc\u0000def", what: "a key with a NUL" },
  ])("refuses $what without asking Stripe or echoing it", async ({ key }) => {
    const asked = stripe(listed);

    const saving = saveStripeKey(key);

    await expect(saving).rejects.toThrow("That isn't a secret key");
    await expect(saving).rejects.not.toThrow(key);
    expect(asked).toEqual([]);
    expect(stripeKeyStatus()).toEqual({ state: "unset" });
  });
});

describe("a charging key that can't read", () => {
  it("stays saved, shown as refused until a read Stripe takes", async () => {
    stripe((url) =>
      url.startsWith("https://api.stripe.com/v1/payment_links") ? listed() : refused(403)(),
    );

    await saveStripeKey("rk_live_chargesonly1234");

    expect(await pulse()).toBe("refused");
    expect(stripeKeyStatus()).toEqual({ last4: "1234", livemode: true, state: "refused" });

    noteStripeRead("rk_live_chargesonly1234", "unanswered");
    expect(stripeKeyStatus().state).toBe("refused");
    noteStripeRead("rk_live_chargesonly1234", "accepted");
    expect(stripeKeyStatus()).toEqual({ last4: "1234", livemode: true, state: "set" });
  });

  it("reads a refused key afresh once it is saved again, since its grants are edited in place", async () => {
    let charges = refused(403);
    const asked = stripe((url) =>
      url.startsWith("https://api.stripe.com/v1/payment_links") ? listed() : charges(),
    );
    await saveStripeKey("rk_live_grantedlater4321");
    expect(await pulse()).toBe("refused");

    charges = listed;
    await saveStripeKey("rk_live_grantedlater4321");
    expect(stripeKeyStatus().state).toBe("set");

    expect(await pulse()).toBe("accepted");
    expect(stripeKeyStatus()).toEqual({ last4: "4321", livemode: true, state: "set" });
    expect(asked.filter(({ url }) => url.includes("/v1/charges"))).toHaveLength(2);
  });

  it("shows a key saved over a refused one as set", async () => {
    stripe(listed);
    await saveStripeKey("rk_live_chargesonly1234");
    noteStripeRead("rk_live_chargesonly1234", "refused");

    await saveStripeKey("rk_live_readstoo5678");

    expect(stripeKeyStatus()).toEqual({ last4: "5678", livemode: true, state: "set" });
  });
});

describe("removing the charging key", () => {
  it("forgets it", async () => {
    stripe(listed);
    await saveStripeKey("sk_live_founder1234");

    removeStripeKey();

    expect(stripeKeyStatus()).toEqual({ state: "unset" });
    expect(getSecret("STRIPE_SECRET_KEY")).toBeNull();
  });

  it("counts a key left blank in the file as none", () => {
    setSecret("STRIPE_SECRET_KEY", "");
    expect(stripeKeyStatus()).toEqual({ state: "unset" });
  });
});
