import { describe, expect, it, vi } from "vitest";
import { mainEnv } from "./host";

// What of the terminal's env a development main gets: the e2e suite's stand-ins ride in on it, and
// a developer's provider login must not, or a run could bill it.

const quiet = (): void => {
  // the dev host's lines go nowhere here
};

describe("main's env under the dev host", () => {
  it("drops what node loads as it starts, whatever main is told", () => {
    vi.stubEnv("NODE_OPTIONS", "--require /tmp/x.js");
    vi.stubEnv("OPENSSL_CONF", "/tmp/openssl.cnf");
    vi.stubEnv("IDLEBIZ_DEV_HOST_KEPT", "kept");
    const env = mainEnv({ env: { NODE_ENV: "development" }, log: quiet });
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.OPENSSL_CONF).toBeUndefined();
    expect(env.IDLEBIZ_DEV_HOST_KEPT).toBe("kept");
    // what the host itself hands main is its own to hand
    expect(env.NODE_ENV).toBe("development");
  });

  it("drops each of the terminal's names `inherit` refuses, and nothing it hands main itself", () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "a real login");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    vi.stubEnv("OPENAI_API_KEY", "another");
    vi.stubEnv("PATH", "/usr/bin:/bin");
    const env = mainEnv({
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" },
      inherit: (name) => !/^(?:ANTHROPIC_|CLAUDE_|OPENAI_)/u.test(name),
      log: quiet,
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1");
  });

  it("hands main its save, and what the host hands over the terminal's", () => {
    vi.stubEnv("IDLEBIZ_ROOT_DIR", "/the/terminal's");
    vi.stubEnv("CLAUDE_BIN", "/the/terminal's/claude");
    const env = mainEnv({ env: { CLAUDE_BIN: "/stand-in/claude" }, log: quiet, root: "/a/save" });
    expect(env.IDLEBIZ_ROOT_DIR).toBe("/a/save");
    expect(env.CLAUDE_BIN).toBe("/stand-in/claude");
  });
});
