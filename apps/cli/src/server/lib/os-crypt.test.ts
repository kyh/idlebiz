import { describe, expect, it } from "vitest";
import { MOCK_KEYCHAIN_PASSWORD, osCryptSealer } from "./os-crypt";

// made apart from this code, by openssl over the key Python's hashlib derives:
// `openssl enc -aes-128-cbc -K <pbkdf2_hmac(sha1, "mock_password", "saltysalt", 1003, 16)> -iv 20…20`
const SEALED_BY_OPENSSL = "djEwVSgJuPeIBX2ufvztacH7EZnqfvZ3CipToMoZstpHtq8=";
const PLAIN = "sk_test_51Hidlebiz";

describe("the v10 sealer", () => {
  const sealer = osCryptSealer(MOCK_KEYCHAIN_PASSWORD);

  it("opens what Chromium's scheme sealed", () => {
    expect(sealer.open(Buffer.from(SEALED_BY_OPENSSL, "base64"))).toBe(PLAIN);
  });

  it("seals byte for byte as Chromium does, so an older build opens it too", () => {
    expect(sealer.seal(PLAIN).toString("base64")).toBe(SEALED_BY_OPENSSL);
  });

  it("refuses a value sealed under another password or another scheme", () => {
    expect(() => osCryptSealer("another").open(Buffer.from(SEALED_BY_OPENSSL, "base64"))).toThrow();
    expect(() => sealer.open(Buffer.from("v11whatever"))).toThrow(/not sealed as v10/u);
  });
});
