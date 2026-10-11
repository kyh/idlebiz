import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach } from "vitest";
import type { Seal } from "./seal";

// What the runs' tests share. Importing this points the save at a root of the importing test
// file's own before anything reads server/paths, and empties it before each test.
export const root = mkdtempSync(path.join(tmpdir(), "idlebiz-driver-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const store = await import("../store/store");

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
  }
});

export const SEAL: Seal = {
  apiSocket: [],
  claudeProjects: { own: null, projects: "/Users/me/.claude/projects" },
  closedPorts: [9222],
  namespaces: {
    claude: { match: "subpath", path: "/Users/me/.agent-browser/namespaces/idlebiz-c" },
    codex: { match: "subpath", path: "/Users/me/.agent-browser/namespaces/idlebiz-x" },
  },
  preferences: "/Users/me/Library/Preferences",
  runners: {
    claude: {
      absent: [],
      account: [{ match: "prefix", path: "/Users/me/.claude.json" }],
      folder: "/Users/me/.claude",
      home: [{ match: "subpath", path: "/Users/me/.claude" }],
      personal: [],
      state: [{ match: "subpath", path: "/Users/me/.claude/sessions" }],
    },
    codex: {
      absent: [{ match: "subpath", path: "/Users/me/.codex/rules" }],
      account: [],
      folder: "/Users/me/.codex",
      home: [{ match: "subpath", path: "/Users/me/.codex" }],
      personal: [{ match: "subpath", path: "/Users/me/.codex/skills" }],
      state: [{ match: "prefix", path: "/Users/me/.codex/auth.json" }],
    },
  },
  runsAsFounder: [],
  save: [{ match: "subpath", path: "/Users/me/.idlebiz" }],
  scratch: [{ match: "subpath", path: "/private/tmp" }],
  skillFolders: [{ match: "subpath", path: "/Users/me/.idlebiz/acme/workspace/.agents" }],
  sockets: [{ match: "subpath", path: "/private/var/run/com.apple.launchd.x/Listeners" }],
  unreadable: [{ match: "prefix", path: "/Users/me/.idlebiz/secrets.json" }],
  writable: [{ match: "subpath", path: "/Users/me/.idlebiz/acme/workspace" }],
};

export const SKILLS = "/Applications/IdleBiz.app/Contents/Resources/skills";

export const found = () =>
  store.foundCompany({
    budget: { mode: "infinite" },
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    hires: [
      {
        name: "Mae",
        persona: "ships",
        role: "engineer",
        runner: "claude",
        spriteSeed: "Mae",
        title: "General Manager",
      },
    ],
    mission: "ship",
    name: "Acme",
  });
