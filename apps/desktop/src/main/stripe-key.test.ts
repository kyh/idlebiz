import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefusalError } from "@/shared/refusal";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-stripe-key-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const { STRIPE_CONNECT_TOKEN, getSecret, setSealer, setSecret } = await import("./secrets");
const { removeStripeKey, saveStripeKey, stripeKeyStatus } = await import("./stripe-key");
const { fetchRealMetrics, stripeCredential } = await import("./metrics");
const { getStripeStatus, noteStripeRead } = await import("./stripe-connect");

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
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
  }
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
    { said: "Stripe answered 500", status: 500, why: "a key Stripe couldn't check" },
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
      "Stripe couldn't be reached (fetch failed) — nothing was saved; try again.",
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
  it("stays saved, and the pulse the save sets off says what it lacks", async () => {
    stripe((url) =>
      url.startsWith("https://api.stripe.com/v1/payment_links") ? listed() : refused(403)(),
    );

    await saveStripeKey("rk_live_chargesonly1234");
    const credential = stripeCredential(null);
    const read = await fetchRealMetrics(credential, [], []);
    noteStripeRead("fixture", read.stripe);

    expect(credential).toEqual({ key: "rk_live_chargesonly1234", via: "own" });
    expect(read.stripe).toEqual({ answer: "refused", via: "own" });
    expect(getStripeStatus("fixture")).toEqual({
      message:
        "Stripe won't let your charging key read charges and customers — grant it Read on both, replace it, or connect Stripe.",
      state: "error",
    });
    expect(stripeKeyStatus()).toEqual({ last4: "1234", livemode: true, state: "set" });
  });
});

describe("removing the charging key", () => {
  it("forgets it and leaves a Stripe connection's token", async () => {
    stripe(listed);
    await saveStripeKey("sk_live_founder1234");
    setSecret(STRIPE_CONNECT_TOKEN, "connect-token");

    removeStripeKey();

    expect(stripeKeyStatus()).toEqual({ state: "unset" });
    expect(getSecret("STRIPE_SECRET_KEY")).toBeNull();
    expect(getSecret(STRIPE_CONNECT_TOKEN)).toBe("connect-token");
  });

  it("counts a key left blank in the file as none", () => {
    setSecret("STRIPE_SECRET_KEY", "");
    expect(stripeKeyStatus()).toEqual({ state: "unset" });
  });
});
