import { describe, expect, it } from "vitest";
import { cdhashIn, parseSearchList, partitionList } from "./update-keychain.ts";

// what `security list-keychains -d user` and `codesign -dvvv` print, as a Mac prints them
const LISTED = `    "/Users/runner/Library/Keychains/login.keychain-db"
    "/Users/runner/Library/Keychains/with space.keychain-db"
`;
const DESCRIBED = `Executable=/private/var/folders/x/T/IdleBiz.app/Contents/MacOS/IdleBiz
Identifier=com.idlebiz.desktop
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=30+7 location=embedded
Hash type=sha256 size=32
CandidateCDHash sha256=0123456789abcdef0123456789abcdef01234567
CandidateCDHashFull sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
Hash choices=sha256
CDHash=0123456789abcdef0123456789abcdef01234567
Signature=adhoc
`;

describe("the update smoke's keychain", () => {
  it("reads the search list as security prints it, a quoted path a line", () => {
    expect(parseSearchList(LISTED)).toStrictEqual([
      "/Users/runner/Library/Keychains/login.keychain-db",
      "/Users/runner/Library/Keychains/with space.keychain-db",
    ]);
    expect(parseSearchList("")).toStrictEqual([]);
  });

  it("reads an ad-hoc app's code identity from its CDHash line alone", () => {
    expect(cdhashIn(DESCRIBED)).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(() => cdhashIn("Signature=adhoc\n")).toThrow(/no CDHash/u);
  });

  it("lets in security's own partitions and each pack's cdhash", () => {
    expect(partitionList(["aa", "bb"])).toBe("apple-tool:,apple:,cdhash:aa,cdhash:bb");
  });
});
