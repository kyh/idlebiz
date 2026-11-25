import { describe, expect, it } from "vitest";
import { sha1In } from "./test-identity.ts";

describe("a throwaway identity's SHA-1", () => {
  it("is the fingerprint openssl prints, in capitals with no colons", () => {
    const pairs = Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(2, "0"));
    expect(sha1In(`SHA1 Fingerprint=${pairs.join(":")}\n`)).toBe(pairs.join("").toUpperCase());
    expect(sha1In(`sha1 Fingerprint=${pairs.join(":").toUpperCase()}`)).toHaveLength(40);
  });

  it("is refused where openssl printed none", () => {
    expect(() => sha1In("unable to load certificate")).toThrow("no SHA-1 fingerprint");
  });
});
