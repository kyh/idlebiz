import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SYSTEM_PATH,
  accountOf,
  logsDir,
  mainEnv,
  resolveRuntime,
  rootArg,
  rootDir,
} from "./runtime";
import type { Packaged } from "./runtime";

const LAUNCHD_SET = [
  "IDLEBIZ_ROOT_DIR",
  "IDLEBIZ_COUNT_TEST_MONEY",
  "IDLEBIZ_STAND_IN",
  "CLAUDE_BIN",
  "CODEX_BIN",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "OPENAI_BASE_URL",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "CODEX_CA_CERTIFICATE",
  "TMPDIR",
  "TMP",
  "TEMP",
] as const;

const each = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, "x"]));

const kai = (temp: string | null, root: string | null) =>
  ({
    account: { home: "/Users/kai", name: "kai", shell: "/bin/zsh", temp },
    root,
  }) satisfies Packaged;

describe("main's environment", () => {
  it("drops what loads into node, and keeps a terminal's env whole but for it", () => {
    const env = mainEnv(
      each([
        "NODE_OPTIONS",
        "NODE_PATH",
        "NODE_ENV",
        "OPENSSL_CONF",
        "OPENSSL_MODULES",
        "HOME",
        "PATH",
        "IDLEBIZ_ROOT_DIR",
        "CLAUDE_BIN",
        "CODEX_HOME",
        "ZDOTDIR",
        "BASH_ENV",
        "SSL_CERT_FILE",
        "TMPDIR",
        "ANTHROPIC_BASE_URL",
      ]),
      null,
    );

    expect(Object.keys(env).toSorted()).toStrictEqual([
      "ANTHROPIC_BASE_URL",
      "BASH_ENV",
      "CLAUDE_BIN",
      "CODEX_HOME",
      "HOME",
      "IDLEBIZ_ROOT_DIR",
      "PATH",
      "SSL_CERT_FILE",
      "TMPDIR",
      "ZDOTDIR",
    ]);
  });

  it("takes the founder from the system in a packaged launch", () => {
    const env = mainEnv(
      {
        ...each(LAUNCHD_SET),
        ANTHROPIC_API_KEY: "sk",
        HOME: "/private/tmp/h",
        HTTPS_PROXY: "http://127.0.0.1:8080",
        LOGNAME: "eve",
        NODE_OPTIONS: "--require /private/tmp/r.js",
        OPENSSL_CONF: "/private/tmp/x.cnf",
        PATH: "/private/tmp/p:/usr/bin",
        SHELL: "/private/tmp/s",
        SSH_AUTH_SOCK: "/private/tmp/agent",
        USER: "eve",
      },
      kai("/var/folders/x/T/", "/scratch/save"),
    );

    expect(env).toStrictEqual({
      ANTHROPIC_API_KEY: "sk",
      HOME: "/Users/kai",
      HTTPS_PROXY: "http://127.0.0.1:8080",
      IDLEBIZ_ROOT_DIR: "/scratch/save",
      LOGNAME: "kai",
      PATH: SYSTEM_PATH,
      SHELL: "/bin/zsh",
      SSH_AUTH_SOCK: "/private/tmp/agent",
      TMPDIR: "/var/folders/x/T/",
      USER: "kai",
    });
  });

  it("names no temp folder or save macOS and the arguments did not", () => {
    const env = mainEnv(each(LAUNCHD_SET), kai(null, null));

    expect(env).toStrictEqual({
      HOME: "/Users/kai",
      LOGNAME: "kai",
      PATH: SYSTEM_PATH,
      SHELL: "/bin/zsh",
      USER: "kai",
    });
  });
});

describe("the account", () => {
  it("is the user database's", () => {
    expect(
      accountOf({ homedir: "/Users/kai", shell: "/bin/zsh", username: "kai" }, "/var/T/"),
    ).toStrictEqual({ home: "/Users/kai", name: "kai", shell: "/bin/zsh", temp: "/var/T/" });
    expect(
      accountOf({ homedir: "/Users/kai", shell: "/bin/zsh", username: "kai" }, "T").temp,
    ).toBeNull();
  });

  it("refuses a home that is no folder and an account with no shell", () => {
    expect(() => accountOf({ homedir: "kai", shell: "/bin/zsh", username: "kai" }, null)).toThrow(
      /no home folder/u,
    );
    expect(() => accountOf({ homedir: "/Users/kai", shell: null, username: "kai" }, null)).toThrow(
      /no login shell/u,
    );
  });
});

describe("the save", () => {
  it("is the one --root= names, a whole token", () => {
    expect(rootArg(["-psn_0_1", "--root=/scratch/save"])).toBe("/scratch/save");
    expect(rootArg(["--root="])).toBeNull();
    expect(rootArg(["--root", "/scratch/save"])).toBeNull();
    expect(rootArg([])).toBeNull();
  });

  it("is ~/.idlebiz, or the override read against the working directory", () => {
    expect(rootDir("/Users/kai", null, "/w")).toBe("/Users/kai/.idlebiz");
    expect(rootDir("/Users/kai", "saves/../a/./b", "/w")).toBe("/w/a/b");
    expect(rootDir("/Users/kai", "/abs", "/w")).toBe("/abs");
  });
});

describe("main's log", () => {
  const appData = "/Users/kai/Library/Application Support";

  it("goes where Console lists a Mac app's logs when packaged", () => {
    expect(logsDir(true, "/Users/kai", appData, "/elsewhere")).toBe(
      "/Users/kai/Library/Logs/IdleBiz",
    );
  });

  it("keeps a development shell's apart, one folder a save", () => {
    expect(logsDir(false, "/Users/kai", appData, "/Users/kai/.idlebiz")).toBe(
      `${appData}/IdleBiz (dev)/logs`,
    );

    const one = logsDir(false, "/Users/kai", appData, "/tmp/a");
    const other = logsDir(false, "/Users/kai", appData, "/tmp/b");

    expect(one).toMatch(/\/IdleBiz \(dev\)\/roots\/[0-9a-f]{16}\/logs$/u);
    expect(one).not.toBe(other);
  });
});

describe("the runtime", () => {
  it("is the checkout's server on the terminal's node in development", () => {
    expect(
      resolveRuntime({
        appPath: "/repo/apps/desktop",
        execPath: "/repo/node_modules/electron/Electron",
        packaged: false,
        resourcesPath: "/nowhere",
      }),
    ).toStrictEqual({ cliDir: "/repo/apps/cli", node: "node" });
  });

  it("is the app's own node and server, and refuses an incomplete install", () => {
    const app = mkdtempSync(path.join(tmpdir(), "idlebiz-runtime-"));
    const macos = path.join(app, "MacOS");
    const server = path.join(app, "Resources", "server");

    const where = {
      appPath: path.join(app, "Resources", "app.asar"),
      execPath: path.join(macos, "IdleBiz"),
      packaged: true,
      resourcesPath: path.join(app, "Resources"),
    };

    expect(() => resolveRuntime(where)).toThrow(/MacOS\/node is missing/u);

    mkdirSync(macos, { recursive: true });
    writeFileSync(path.join(macos, "node"), "");
    mkdirSync(path.join(server, "dist", "page"), { recursive: true });
    mkdirSync(path.join(server, "resources", "skills"), { recursive: true });
    writeFileSync(path.join(server, "dist", "index.js"), "");

    expect(() => resolveRuntime(where)).toThrow(/page\/index.html is missing/u);

    writeFileSync(path.join(server, "dist", "page", "index.html"), "");

    expect(resolveRuntime(where)).toStrictEqual({ cliDir: server, node: path.join(macos, "node") });
  });
});
