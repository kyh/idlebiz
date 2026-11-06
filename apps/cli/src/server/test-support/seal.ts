import type { Seal } from "../agents/seal";
import { foundAcme, hire } from "./save";

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
  skillFolders: [
    { match: "subpath", path: "/Users/me/.idlebiz/company/products/ledger/workspace/.agents" },
  ],
  sockets: [{ match: "subpath", path: "/private/var/run/com.apple.launchd.x/Listeners" }],
  unreadable: [{ match: "prefix", path: "/Users/me/.idlebiz/secrets.json" }],
  writable: [{ match: "subpath", path: "/Users/me/.idlebiz/company/products/ledger/workspace" }],
};

export const SKILLS = "/Applications/IdleBiz.app/Contents/Resources/skills";

/** Acme, founded with Mae alone. */
export const found = () => foundAcme([hire("Mae", "General Manager")]);
