import { describe, expect, it } from "vitest";
import { identityRefusal, namedWith, proxiesOf, unsealedEnv } from "./founder-env";

// what a `launchctl setenv` could have left in main's env, beside the account's own
const LAUNCHD = {
  BASH_ENV: "/private/tmp/run/env.sh",
  "BASH_FUNC_echo%%": "() { /usr/bin/touch /private/tmp/run/m; }",
  CURL_HOME: "/private/tmp/run",
  DEVELOPER_DIR: "/private/tmp/run/dev",
  ENV: "/private/tmp/run/env.sh",
  FPATH: "/private/tmp/run/functions",
  GIT_TEMPLATE_DIR: "/private/tmp/run/templates",
  PERL5OPT: "-M/private/tmp/run/x",
  PS4: "$(/usr/bin/touch /private/tmp/run/m)",
  PYTHONPATH: "/private/tmp/run",
  RUBYOPT: "-r/private/tmp/run/x",
  SHELLOPTS: "xtrace",
  SSL_CERT_FILE: "/private/tmp/run/ca.pem",
  XDG_CONFIG_HOME: "/private/tmp/run/config",
  ZDOTDIR: "/private/tmp/run/zdot",
} as const;

const ACCOUNT = {
  HOME: "/Users/kai",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  LC_CTYPE: "en_US.UTF-8",
  LOGNAME: "kai",
  SHELL: "/bin/zsh",
  TMPDIR: "/var/folders/x/T/",
  USER: "kai",
  __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
} as const;

describe("unsealedEnv", () => {
  it("keeps the account's names, the locale and what it is handed, and nothing else of main's", () => {
    const env = { ...LAUNCHD, ...ACCOUNT, ANTHROPIC_API_KEY: "sk-ant", PATH: "/private/tmp/p" };

    expect(unsealedEnv(env, { PATH: "/usr/bin:/bin" })).toEqual({
      ...ACCOUNT,
      PATH: "/usr/bin:/bin",
    });
  });

  it("leaves out a name main's env does not hold", () => {
    expect(unsealedEnv({ HOME: "/Users/kai", USER: undefined }, {})).toEqual({
      HOME: "/Users/kai",
    });
  });
});

describe("proxiesOf", () => {
  it("keeps the founder's proxies in either case, and nothing else", () => {
    const proxies = {
      HTTPS_PROXY: "http://proxy.test:3128",
      NO_PROXY: "localhost",
      all_proxy: "socks5://proxy.test:1080",
      http_proxy: "http://proxy.test:3128",
      https_proxy: "http://proxy.test:3128",
    };

    expect(
      proxiesOf({ ...proxies, ...LAUNCHD, CURL_CA_BUNDLE: "/private/tmp/run/ca.pem" }),
    ).toEqual(proxies);
  });
});

describe("namedWith", () => {
  it("keeps what is named with one of the prefixes", () => {
    expect(
      namedWith({ ANTHROPIC_MODEL: "opus", CLAUDE_CONFIG_DIR: "/c", OPENAI_API_KEY: "sk" }, [
        "ANTHROPIC_",
        "CLAUDE_",
      ]),
    ).toEqual({ ANTHROPIC_MODEL: "opus", CLAUDE_CONFIG_DIR: "/c" });
  });
});

describe("identityRefusal", () => {
  const kai = { homedir: "/Users/kai", shell: "/bin/zsh" };

  it("passes the account's HOME and SHELL", () => {
    expect(identityRefusal("/Users/kai", "/bin/zsh", kai)).toBeNull();
  });

  it("refuses a HOME that is not the account's", () => {
    expect(identityRefusal("/private/tmp/h", "/bin/zsh", kai)).toBe(
      "IdleBiz was started with /private/tmp/h as your home folder, but macOS says yours is /Users/kai: it opens a save and seals runs only under the home folder that is yours.",
    );
  });

  it("refuses a SHELL that is not the account's, or none where the account has one", () => {
    expect(identityRefusal("/Users/kai", "/private/tmp/s", kai)).toBe(
      "IdleBiz was started with /private/tmp/s as your shell, but macOS says yours is /bin/zsh: it looks for your coding CLIs only on the PATH your own shell sets.",
    );
    expect(identityRefusal("/Users/kai", undefined, kai)).toMatch(
      /^IdleBiz was started with no shell/u,
    );
  });

  it("passes an account with no shell, started with none", () => {
    for (const shell of [null, ""]) {
      expect(identityRefusal("/Users/kai", "", { homedir: "/Users/kai", shell })).toBeNull();
      expect(identityRefusal("/Users/kai", undefined, { homedir: "/Users/kai", shell })).toBeNull();
    }
  });
});
