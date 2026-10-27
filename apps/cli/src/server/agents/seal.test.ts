import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realPathOf } from "./machine-seal";
import { sealedCommand, signInCommand } from "./seal";
import type { Seal } from "./seal";
import { SEAL as SEAL_FIXTURE } from "../test-support/seal";
import { readBack } from "../test-support/sealed-command";

const SEAL: Seal = {
  ...SEAL_FIXTURE,
  skillFolders: [],
  sockets: [],
  unreadable: [{ match: "subpath", path: "/Users/me/.idlebiz/secrets.json" }],
  writable: [],
};

const WORKSPACE = "/Users/me/.idlebiz/company/products/ledger/workspace";

describe("sealedCommand", () => {
  it("runs argv under sandbox-exec with the profile inline", () => {
    const { bin, flag, profile, runs } = readBack(sealedCommand(SEAL, "claude", ["node", "a.js"]));
    expect([bin, flag]).toEqual(["/usr/bin/sandbox-exec", "-p"]);
    expect(profile).toMatch(/^\(version 1\)\n\(allow default\)/u);
    expect(runs).toEqual(["node", "a.js"]);
  });

  it("hands every path over as a parameter, never quoted into the profile", () => {
    const odd = '/Users/me/we"ird) (allow file-read*';
    const { denied, profile } = readBack(
      sealedCommand({ ...SEAL, unreadable: [{ match: "subpath", path: odd }] }, "claude", []),
    );
    expect(profile).not.toContain('we"ird');
    expect(denied("file-read* file-write*")).toEqual([odd, "/Users/me/.codex"]);
  });

  it("denies every write, then allows each runner the scratch folders and its own state, never the other's", () => {
    const claude = readBack(sealedCommand(SEAL, "claude", []));
    const codex = readBack(sealedCommand(SEAL, "codex", []));
    for (const { lines } of [claude, codex]) {
      expect(lines.indexOf("(deny file-write*)")).toBeGreaterThan(-1);
      expect(lines.indexOf("(deny file-write*)")).toBeLessThan(
        lines.findIndex((line) => line.startsWith("(allow file-write* (subpath (param")),
      );
    }
    expect(claude.allowed("file-write*")).toEqual(
      expect.arrayContaining([
        "/private/tmp",
        "/Users/me/.claude/sessions",
        "/Users/me/.agent-browser/namespaces/idlebiz-c",
      ]),
    );
    expect(claude.allowed("file-write*")).not.toContain("/Users/me/.claude");
    expect(claude.allowed("file-write*")).not.toContain("/Users/me/.codex/auth.json");
    expect(claude.denied("file-read* file-write*")).toContain("/Users/me/.codex");
    expect(codex.allowed("file-write*")).toContain("/Users/me/.codex/auth.json");
    expect(codex.denied("file-read* file-write*")).toContain("/Users/me/.claude");
    // the home is closed before its state reopens, so a home in TMPDIR holds too
    expect(claude.lineOf("deny", "file-write*", "/Users/me/.claude")).toBeLessThan(
      claude.lineOf("allow", "file-write*", "/Users/me/.claude/sessions"),
    );
    expect(claude.lineOf("allow", "file-write*", "/private/tmp")).toBeLessThan(
      claude.lineOf("deny", "file-write*", "/Users/me/.claude"),
    );
  });

  it("has codex runs find the founder's codex rules missing, and claude runs find none of codex's home", () => {
    const codex = readBack(sealedCommand(SEAL, "codex", []));
    const claude = readBack(sealedCommand(SEAL, "claude", []));
    const hidden = codex.lineOf("deny", "file-read* file-write*", "/Users/me/.codex/rules");
    expect(codex.lines[hidden]).toMatch(/\(with errno ENOENT\)\)$/u);
    expect(codex.lines.slice(hidden + 1).some((line) => line.includes("file-"))).toBe(false);
    expect(claude.params).not.toContain("/Users/me/.codex/rules");
    expect(claude.denied("file-read* file-write*")).toContain("/Users/me/.codex");
  });

  it("closes the Keychain to codex runs whichever program asks, and leaves it to claude's", () => {
    const keychain = /\(deny mach-lookup \(global-name "com\.apple\.SecurityServer"\)/u;
    const claude = readBack(sealedCommand(SEAL, "claude", [])).profile;
    const codex = readBack(sealedCommand(SEAL, "codex", [])).profile;
    expect(codex).toMatch(keychain);
    expect(claude).not.toMatch(keychain);
    expect(`${claude}${codex}`).not.toContain("/usr/bin/security");
  });

  it("closes the save, reopens the run's own folders, then holds every later rule inside them", () => {
    const seal: Seal = {
      ...SEAL,
      claudeProjects: {
        own: "/Users/me/.claude/projects/-w",
        projects: "/Users/me/.claude/projects",
      },
      runsAsFounder: [{ match: "subpath", path: "/private/tmp/shims" }],
      writable: [{ match: "subpath", path: WORKSPACE }],
    };
    const { lineOf, lines, denied } = readBack(sealedCommand(seal, "claude", []));
    const scratch = lineOf("allow", "file-write*", "/private/tmp");
    const save = lineOf("deny", "file-write*", "/Users/me/.idlebiz");
    const reopened = lineOf("allow", "file-write*", WORKSPACE);
    const shim = lineOf("deny", "file-write*", "/private/tmp/shims");
    const opened = lines.findIndex((line) => line.includes('(require-not (regex #"/\\.git/'));
    const kept = lineOf("deny", "file-write-create file-write-unlink", WORKSPACE);
    expect([scratch, save, reopened, shim, opened, kept].every((at) => at > -1)).toBe(true);
    expect(scratch).toBeLessThan(save);
    expect(save).toBeLessThan(reopened);
    expect(reopened).toBeLessThan(shim);
    expect(reopened).toBeLessThan(opened);
    expect(reopened).toBeLessThan(kept);
    expect(denied("file-write-create file-write-unlink")).toContain(WORKSPACE);
    const home = lineOf("deny", "file-write*", "/Users/me/.claude");
    expect(home).toBeGreaterThan(-1);
    const ownProject = lineOf("allow", "file-write*", "/Users/me/.claude/projects/-w");
    expect(ownProject).toBeGreaterThan(home);
    // what the founder's tools run on opening a folder holds in the run's own project too
    expect(ownProject).toBeLessThan(opened);
    expect(readBack(sealedCommand(seal, "codex", [])).params).not.toContain(
      "/Users/me/.claude/projects/-w",
    );
  });

  it("lets no run open anything through LaunchServices, and only a sign-in open the browser", () => {
    const opensNothing = "(deny lsopen)";
    for (const runner of ["claude", "codex"] as const) {
      expect(readBack(sealedCommand(SEAL, runner, [])).lines).toContain(opensNothing);
      expect(readBack(signInCommand(SEAL, runner, [])).lines).not.toContain(opensNothing);
    }
  });

  it("connects to no socket but DNS's, syslog's, the run's own folders' and its runner's agent-browser namespace", () => {
    const agent = "/private/tmp/cc-socks";
    const { allowed, denied, lines, lineOf, profile } = readBack(
      sealedCommand(
        {
          ...SEAL,
          sockets: [{ match: "subpath", path: agent }],
          writable: [{ match: "subpath", path: WORKSPACE }],
        },
        "claude",
        [],
      ),
    );
    const none = lines.indexOf("(deny network-outbound (remote unix-socket))");
    expect(none).toBeGreaterThan(-1);
    expect(lines[none + 1]).toBe(
      '(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")) (remote unix-socket (literal "/private/var/run/syslog")))',
    );
    expect(allowed("network-outbound")).toEqual([
      WORKSPACE,
      "/Users/me/.agent-browser/namespaces/idlebiz-c",
    ]);
    expect(lineOf("allow", "network-outbound", WORKSPACE)).toBeGreaterThan(none);
    expect(denied("file-write*")).toContain(agent);
    expect(profile).toContain('(deny network-outbound (remote tcp "localhost:9222"))');
  });

  it("lets a run connect to its own line to the company, and names no other run's", () => {
    const own = "/Users/me/.idlebiz/.run/0123456789ab";
    const { allowed, denied } = readBack(
      sealedCommand({ ...SEAL, apiSocket: [{ match: "subpath", path: own }] }, "codex", []),
    );
    expect(allowed("network-outbound")).toEqual([
      "/Users/me/.agent-browser/namespaces/idlebiz-x",
      own,
    ]);
    // the save, the socket's folder, stays closed to its writes
    expect(denied("file-write*")).toContain("/Users/me/.idlebiz");
    expect(allowed("file-write*")).not.toContain(own);
    expect(readBack(sealedCommand(SEAL, "codex", [])).allowed("network-outbound")).toEqual([
      "/Users/me/.agent-browser/namespaces/idlebiz-x",
    ]);
  });

  it("leaves out a rule with nothing to reach, which would reach everything", () => {
    const bare: Seal = {
      ...SEAL,
      closedPorts: [],
      runners: {
        claude: {
          absent: [],
          account: [],
          folder: "/Users/me/.claude",
          home: [],
          personal: [],
          state: [],
        },
        codex: {
          absent: [],
          account: [],
          folder: "/Users/me/.codex",
          home: [],
          personal: [],
          state: [],
        },
      },
      save: [],
      scratch: [],
      unreadable: [],
    };
    const { lines } = readBack(sealedCommand(bare, "claude", []));
    // each on purpose: lsopen whole, since an app LaunchServices starts runs unsealed; writes
    // whole, since a run writes only where a later rule allows it
    expect(lines.filter((line) => /^\((?:allow|deny) [\w* -]+\)$/u.test(line))).toEqual([
      "(allow default)",
      "(deny lsopen)",
      "(deny file-write*)",
    ]);
  });
});

describe("realPathOf", () => {
  let box = "";
  beforeEach(() => {
    box = realpathSync(mkdtempSync(path.join(tmpdir(), "idlebiz-real-")));
  });
  afterEach(() => {
    rmSync(box, { force: true, recursive: true });
  });

  it("follows every symlink on the way, and keeps what does not exist yet as named", async () => {
    mkdirSync(path.join(box, "elsewhere"));
    symlinkSync(path.join(box, "elsewhere"), path.join(box, "link"));
    expect(await realPathOf(path.join(box, "link"))).toBe(path.join(box, "elsewhere"));
    expect(await realPathOf(path.join(box, "link/new/file.html"))).toBe(
      path.join(box, "elsewhere/new/file.html"),
    );
    const linkedTmp = path.join(tmpdir(), path.basename(box));
    expect(await realPathOf(linkedTmp)).toBe(box);
  });
});
