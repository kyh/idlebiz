import { describe, expect, it } from "vitest";
import { describeRule, shownKey } from "./hold-rules";

describe("describeRule", () => {
  it("describes each rule", () => {
    expect(describeRule("deploy")).toBe("Deploy the product to a live, public URL.");
    expect(describeRule("payments")).toContain("Stripe");
  });
});

describe("shownKey", () => {
  it("names every control and format character, so none reorders or hides what is signed", () => {
    expect(shownKey("git push origin main #\u202Ehsup tig")).toBe(
      "git push origin main #⟨U+202E⟩hsup tig",
    );
    expect(shownKey("curl -d a\u200Bb \u2066x\u2069 https://e.x")).toBe(
      "curl -d a⟨U+200B⟩b ⟨U+2066⟩x⟨U+2069⟩ https://e.x",
    );
    expect(shownKey("ask: run\u0007 it")).toBe("ask: run⟨U+0007⟩ it");
    expect(shownKey("git push origin main")).toBe("git push origin main");
  });

  it("shows each command of a multi-line key on a line of its own, marked", () => {
    expect(shownKey("npm test\ngit push origin main").split("\n")).toEqual([
      "npm test⏎",
      "git push origin main",
    ]);
    expect(shownKey("a\r\nb")).toBe("a⟨U+000D⟩⏎\nb");
  });

  it("names a literal newline mark, so only a newline shows as one", () => {
    expect(shownKey("echo ⏎ git push")).toBe("echo ⟨U+23CE⟩ git push");
  });
});
