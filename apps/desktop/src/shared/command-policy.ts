import type { ToolAsk } from "@repo/agent-driver/tool-ask";

// Applied to ACP permission requests from both runners. Unmatched commands run;
// the CLIs' own safeguards still apply. Persist rule ids so approval cards can explain them.
const RULE_IDS = [
  "deploy",
  "publish-package",
  "git-push",
  "github-create",
  "payments",
  "http-write",
  "remote-copy",
  "pipe-to-shell",
  "read-credentials",
  "destructive-outside",
  "write-outside",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

interface CommandRule {
  id: RuleId | "browser-act" | "browser-unseen" | "external-tool" | "sandbox-widen";
  /** Shown on the approval card — what the founder is being asked to allow. */
  describe: string;
}

interface Rule extends CommandRule {
  match: RegExp;
  /** Skip when everything the command targets is the game's own loopback API. */
  networked?: boolean;
}

/** Subcommands of the deploy CLIs that only read — everything else ships. */
const DEPLOY_TOOL_READS = String.raw`(?:--help|--version|-h|-v|help|ls|list|inspect|logs?|whoami|login|logout|link|unlink|env|teams|projects|domains|certs|secrets|dev|build|pull|open|switch)`;

/** A path argument that leaves the workspace behind. */
const ESCAPES = String.raw`(?:~|/(?:Users|home|etc|var|opt|System)\b|/Library\b)`;

// Anchor at invocation sites so quoted reports of a blocked command do not block again.
// This is a heuristic: separators inside quotes still count, while bare `(` and
// backticks do not (common in prose). Command substitution via `$(` still counts.
const AT_COMMAND = String.raw`(?:^|[\n;&|]|\$\()\s*(?:(?:sudo|command|env|time|nohup|npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|npm\s+exec)\s+)*(?:--?[\w-]+\s+)*(?:[\w_]+=\S+\s+)*`;

const invocation = (program: string): RegExp => new RegExp(AT_COMMAND + program, "u");

/**
 * One of `names` as a whole program token: `vercel` the CLI, not `vercel.json`
 * the file or `vercel-cli` the package. A word boundary alone accepts both.
 */
const program = (names: string): string => String.raw`(?:${names})(?![\w.\-/])`;

const RULES: readonly Rule[] = [
  {
    describe: "Deploy the product to a live, public URL.",
    id: "deploy",
    // Bare `vercel` deploys; exclude read-only subcommands rather than listing deploy verbs.
    match: invocation(
      `${program("vercel|netlify|wrangler|fly|railway|surge")}${String.raw`(?!\s+${DEPLOY_TOOL_READS}\b)`}`,
    ),
  },
  {
    describe: "Publish a package to a public registry.",
    id: "publish-package",
    match: invocation(`${program("npm|pnpm|yarn|bun")}${String.raw`[^|;&]*\bpublish\b`}`),
  },
  {
    describe: "Push commits to a remote repository.",
    id: "git-push",
    // Accept global options. Quoted option values with spaces still need a shell parser.
    match: invocation(
      String.raw`git\b(?:\s+-[a-zA-Z-]+(?:=\S+)?(?:\s+(?!push\b)-?\S+)?)*\s+push\b`,
    ),
  },
  {
    describe: "Create something public on GitHub (PR, release, repo, or issue).",
    id: "github-create",
    match: invocation(
      String.raw`gh\s+(?:(?:pr|release|repo|issue|gist)\s+create\b` +
        String.raw`|api\b[^|;&]*(?:\s-X\s*|\s--method[=\s])(?:POST|PUT|PATCH|DELETE)\b)`,
    ),
  },
  {
    describe: "Move real money through Stripe.",
    id: "payments",
    match: invocation(
      `${program("stripe")}${String.raw`[^|;&]*\b(?:create|charge|payouts?|refunds?|transfers?)\b`}`,
    ),
  },
  {
    describe: "Send data to a service on the internet.",
    id: "http-write",
    match: invocation(
      String.raw`(?:curl\b[^|;&]*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b` +
        // --json is shorthand for --data-binary + headers; -F/-T upload files
        String.raw`|\s(?:--data|--data-raw|--data-binary|--data-urlencode|--json|--form|--upload-file|-d|-F|-T)[\s=])` +
        String.raw`|wget\b[^|;&]*\s(?:--post-data|--post-file|--method[=\s]*(?:POST|PUT|PATCH|DELETE))\b)`,
    ),
    networked: true,
  },
  {
    describe: "Copy files to another machine over the network.",
    id: "remote-copy",
    match: invocation(
      String.raw`(?:(?:scp|rsync)\b[^|;&]*\s[\w.-]+@[\w.-]+:|ssh\s+[\w.-]+@[\w.-]+)`,
    ),
    networked: true,
  },
  {
    describe: "Download code from the internet and run it immediately.",
    id: "pipe-to-shell",
    match: invocation(String.raw`(?:curl|wget)\b[^;&]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|python3?)\b`),
    networked: true,
  },
  {
    describe: "Read your stored credentials.",
    id: "read-credentials",
    match: invocation(
      String.raw`(?:(?:cat|less|more|head|tail|strings|grep|cp|base64|openssl)\b[^|;&]*${ESCAPES}/\.(?:ssh|aws|gnupg|config/gh)\b` +
        String.raw`|security\s+find-(?:generic|internet)-password\b)`,
    ),
  },
  {
    describe: "Irreversibly delete or overwrite files outside the workspace.",
    id: "destructive-outside",
    match: invocation(String.raw`(?:rm|shred|truncate)\b[^|;&]*\s-?[\w-]*\s*${ESCAPES}`),
  },
  {
    describe: "Change files or permissions outside the workspace.",
    id: "write-outside",
    match: invocation(String.raw`(?:chmod|chown|mv|dd\s+of=|tee)\b[^|;&]*${ESCAPES}`),
  },
];

/** Approvals that cover the rest of a run rather than one command: what the founder signs is the site or the server, not the keystroke. */
const LEASE_RULES = [
  {
    describe:
      "Act in a real browser on this site — log in, type, click, submit — for the rest of this run.",
    id: "browser-act",
  },
  // Employee sessions load the founder's own CLI settings, so every MCP server
  // the founder connected for themselves — a browser, a mailbox, a chat
  // workspace — is in the employee's hands too, already signed in.
  {
    describe:
      "Use a tool connected in your own CLI settings (an MCP server, signed in as you) for the rest of this run.",
    id: "external-tool",
  },
] as const satisfies readonly CommandRule[];

/** Signed for like a shell command, once and exactly: no site can be named, so there is nothing to lease. */
const BROWSER_UNSEEN_RULE = {
  describe:
    "Act in a real browser on a page nobody could check first — one run of exactly this command.",
  id: "browser-unseen",
} as const satisfies CommandRule;

/** Signed for once and exactly, never leased: a widened sandbox already lets every later command in the run skip asking. */
const SANDBOX_RULE = {
  describe:
    "Let this run reach the internet or write outside its workspace without asking again, for every command until the run ends.",
  id: "sandbox-widen",
} as const satisfies CommandRule;

const LOOPBACK_HOST = String.raw`https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?:[:/]|$)`;
const LOOPBACK_URL = new RegExp(`^(?:${LOOPBACK_HOST}|file:|about:)`, "u");

const BROWSER_CALL = new RegExp(
  AT_COMMAND + program("agent-browser") + String.raw`(?<args>[^\n;&|]*)`,
  "gu",
);

const verbs = (names: readonly string[]): RegExp =>
  new RegExp(String.raw`(?:^|\s)(?:${names.join("|")})(?:\s|$)`, "u");

/** Acts that set a value and leave the page where it was. */
const SETS = ["fill", "type", "check", "uncheck", "upload"];
/** Acts that can take the page anywhere: a click or a key press goes wherever the site sends it. */
const LEAVES = [
  "click",
  "dblclick",
  "press",
  "key",
  "keydown",
  "keyup",
  "keyboard",
  "select",
  "drag",
  "eval",
  "find",
  "mouse",
  "download",
  String.raw`dialog\s+accept`,
  String.raw`webmcp\s+invoke`,
];
/** Reads that change which page the next step acts on. */
const NAVIGATES = [
  "back",
  "forward",
  "tab",
  "window",
  "frame",
  "pushstate",
  "connect",
  "a11y",
  "vitals",
  "record",
  "diff",
];

/** Verbs that change a page. Reading — open, read, snapshot, get, screenshot, scroll, wait — stays free. */
const BROWSER_WRITES = verbs([...SETS, ...LEAVES]);
/** Verbs after which nothing in the command says where the page is. */
const BROWSER_MOVES = verbs([...LEAVES, ...NAVIGATES]);
/** Verbs whose steps the command does not show: an AI at the wheel, a batch (its steps can be strings, JSON or stdin), a saved login's own page. */
const BROWSER_BLIND = verbs(["batch", "chat", "mcp", String.raw`auth\s+login`]);
const BROWSER_OPEN = /(?:^|\s)(?:open|goto|navigate)\s+["']?(?<url>[^\s"']+)/u;

const hostOf = (url: string): string | null => {
  try {
    return new URL(/^[a-z][a-z\d+.-]*:/iu.test(url) ? url : `https://${url}`).host || null;
  } catch {
    return null;
  }
};

/** Where a browser session is right now; null when nothing could say. "" is the default session. */
export type LiveUrl = (session: string) => Promise<string | null>;

const unseen = (command: string): Hold => ({
  key: command,
  leasable: false,
  rule: BROWSER_UNSEEN_RULE.id,
});

/** What acting on the page at `url` waits on, or null when it may run. A null `url` is a page nobody knows. */
const actHold = (url: string | null, leases: ReadonlySet<string>, command: string): Hold | null => {
  if (url !== null && LOOPBACK_URL.test(url)) {
    return null;
  }
  const host = url === null ? null : hostOf(url);
  if (host === null) {
    return unseen(command);
  }
  const key = `agent-browser: act on ${host}`;
  return leases.has(key) ? null : { key, leasable: true, rule: "browser-act" };
};

/**
 * The approval a browser command needs and does not have, or null when it may run.
 * A command names a verb, never a site, so the site comes from the browser
 * itself: a click on the team's own localhost build can land anywhere, and only
 * the live URL knows. That URL is read before the command runs, so an `open`
 * earlier in the same chained command wins, and any act after a step that may
 * have moved the page lands somewhere nobody could read.
 */
const heldBrowserAct = async (
  command: string,
  leases: ReadonlySet<string>,
  liveUrl: LiveUrl,
): Promise<Hold | null> => {
  // Per session, where the page will be when the next step runs: absent is where the live URL says, null is anywhere.
  const pages = new Map<string, string | null>();
  for (const call of command.matchAll(BROWSER_CALL)) {
    const args = call.groups?.args ?? "";
    if (BROWSER_BLIND.test(args)) {
      return unseen(command);
    }
    const session = /--session[=\s]+(?<name>\S+)/u.exec(args)?.groups?.name ?? "";
    const opened = BROWSER_OPEN.exec(args)?.groups?.url;
    if (!BROWSER_WRITES.test(args)) {
      if (opened !== undefined) {
        pages.set(session, opened);
      } else if (BROWSER_MOVES.test(args)) {
        pages.set(session, null);
      }
      continue;
    }
    const known = pages.get(session);
    const url = known === undefined ? await liveUrl(session) : known;
    const held = actHold(url, leases, command);
    if (held !== null) {
      return held;
    }
    // A write whose text also names a verb that moves or opens is read as having moved.
    pages.set(session, opened === undefined && !BROWSER_MOVES.test(args) ? url : null);
  }
  return null;
};

/** True when every internet target named is the game's own loopback API. */
const onlyLoopbackTargets = (command: string): boolean => {
  const urls = command.match(/https?:\/\/[^\s"'`)]+/gu) ?? [];
  const remote = urls.filter((u) => !LOOPBACK_URL.test(u));
  if (remote.length > 0) {
    return false;
  }
  return urls.length > 0 || command.includes("$IDLEBIZ_API_URL");
};

export type CommandVerdict = { decision: "allow" } | { decision: "ask"; rule: CommandRule };

/** What the approval card says about a held command, by the rule that held it. */
export const describeRule = (id: string): string =>
  [...RULES, ...LEASE_RULES, BROWSER_UNSEEN_RULE, SANDBOX_RULE].find((rule) => rule.id === id)
    ?.describe ?? `Saved rule "${id}" is unavailable in this version.`;

export const classifyCommand = (command: string): CommandVerdict => {
  for (const rule of RULES) {
    if (!rule.match.test(command)) {
      continue;
    }
    if (rule.networked && onlyLoopbackTargets(command)) {
      continue;
    }
    return { decision: "ask", rule };
  }
  return { decision: "allow" };
};

/** Remove CLI reporting suffixes and normalize the key used to reuse founder approvals. */
export const normalizeCommand = (command: string): string =>
  command
    .replaceAll(/\s*2>&1/gu, "")
    .replace(/\s*;\s*echo\s+["']?exit=\$\?["']?\s*$/u, "")
    .trim()
    .replaceAll(/\s+/gu, " ");

/** What a tool call waits on: the approval the founder signs, and whether signing covers the rest of the run. */
export interface Hold {
  /** The approval key, and the text on the founder's card. */
  key: string;
  rule: CommandRule["id"];
  leasable: boolean;
}

/** The one judgement every tool call passes through; null lets it run. `leases` is what this run was already signed for. */
export const holdFor = async (
  tool: ToolAsk,
  leases: ReadonlySet<string>,
  liveUrl: LiveUrl,
): Promise<Hold | null> => {
  if (tool.kind === "mcp") {
    // a server nothing can name is signed for call by call: a lease on "unknown" would cover every such server
    const key = `mcp: use ${tool.server ?? "a tool nothing could name"}`;
    return leases.has(key) ? null : { key, leasable: tool.server !== null, rule: "external-tool" };
  }
  if (tool.kind === "sandbox") {
    const reach = [...(tool.network ? ["network"] : []), ...tool.paths].join(", ");
    return {
      key: `sandbox: widen to ${reach || "more access"}`,
      leasable: false,
      rule: SANDBOX_RULE.id,
    };
  }
  const command = normalizeCommand(tool.command);
  const verdict = classifyCommand(command);
  if (verdict.decision === "ask") {
    return { key: command, leasable: false, rule: verdict.rule.id };
  }
  return await heldBrowserAct(command, leases, liveUrl);
};
