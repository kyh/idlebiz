import { describe, expect, it } from "vitest";
import { approvalScope, describeRule, shownKey } from "./hold-rules";

describe("describeRule", () => {
  it("describes each rule", () => {
    expect(describeRule("git-push")).toBe("Push commits to a remote repository.");
    expect(describeRule("browser-unseen")).toContain("one run of exactly this command");
    expect(describeRule("unknown-ask")).toContain("one run of exactly this");
  });

  it("says a leased approval covers the rest of the run, and any other one run", () => {
    expect(approvalScope("browser-act")).toContain("rest of this run");
    expect(approvalScope("external-tool")).toContain("rest of this run");
    expect(approvalScope("git-push")).toContain("once");
    expect(approvalScope("unknown-ask")).toContain("once");
  });
});

describe("shownKey", () => {
  it("names every control and format character, so none reorders or hides what is signed", () => {
    expect(shownKey("git push origin main #‮hsup tig")).toBe(
      "git push origin main #⟨U+202E⟩hsup tig",
    );
    expect(shownKey("curl -d a​b ⁦x⁩ https://e.x")).toBe(
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
