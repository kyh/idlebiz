import { describe, expect, it } from "vitest";
import {
  ConnectedAccountSchema,
  encodeState,
  loopbackUrl,
  parseCallback,
  parseState,
  type ConnectedAccount,
} from "./protocol";
import { newKeyring, open, seal } from "./seal";

const account: ConnectedAccount = {
  accessToken: "sk_test_51ExampleToken",
  stripeUserId: "acct_1Example",
  livemode: false,
};

describe("the sealed envelope", () => {
  it("opens only for the keyring that started the flow", async () => {
    const ours = await newKeyring();
    const theirs = await newKeyring();
    const sealed = await seal(ours.publicKey, account);
    expect(await open(ours, sealed, ConnectedAccountSchema)).toEqual(account);
    expect(await open(theirs, sealed, ConnectedAccountSchema)).toBeNull();
  });

  it("refuses a tampered, truncated or foreign envelope", async () => {
    const ring = await newKeyring();
    const sealed = await seal(ring.publicKey, account);
    const flipped = `${sealed.slice(0, -2)}${sealed.at(-2) === "A" ? "B" : "A"}${sealed.at(-1)}`;
    expect(await open(ring, flipped, ConnectedAccountSchema)).toBeNull();
    expect(await open(ring, sealed.slice(0, 40), ConnectedAccountSchema)).toBeNull();
    expect(await open(ring, "not-an-envelope", ConnectedAccountSchema)).toBeNull();
  });

  it("carries no field the account schema does not name", async () => {
    const ring = await newKeyring();
    const sealed = await seal(ring.publicKey, { ...account, extra: "x" });
    expect(await open(ring, sealed, ConnectedAccountSchema)).toEqual(account);
    const missing = await seal(ring.publicKey, { accessToken: "sk" });
    expect(await open(ring, missing, ConnectedAccountSchema)).toBeNull();
  });
});

describe("the state and the loopback URL", () => {
  it("round-trips the state through Stripe's opaque string", async () => {
    const { publicKey } = await newKeyring();
    const state = { port: 4321, nonce: "abcdefghijklmnop", key: publicKey };
    expect(parseState(encodeState(state))).toEqual(state);
    expect(parseState("nope")).toBeNull();
    expect(parseState(encodeState({ ...state, key: "short" }))).toBeNull();
  });

  it("puts only the nonce and the envelope on the loopback", async () => {
    const { publicKey } = await newKeyring();
    const state = { port: 4321, nonce: "abcdefghijklmnop", key: publicKey };
    const url = new URL(loopbackUrl(state, { kind: "sealed", sealed: "AAAA" }));
    expect(url.port).toBe("4321");
    expect([...url.searchParams.keys()].toSorted()).toEqual(["nonce", "sealed"]);
    expect(parseCallback(url.searchParams)).toEqual({
      nonce: state.nonce,
      outcome: { kind: "sealed", sealed: "AAAA" },
    });
    const failed = new URL(loopbackUrl(state, { kind: "failed", error: "access_denied" }));
    expect(parseCallback(failed.searchParams)).toEqual({
      nonce: state.nonce,
      outcome: { kind: "failed", error: "access_denied" },
    });
  });
});
