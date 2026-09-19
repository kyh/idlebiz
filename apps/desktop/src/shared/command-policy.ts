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
  /** `browser-act` and `external-tool` are leased per run, not judged from a shell command alone. */
  id: RuleId | "browser-act" | "external-tool";
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

/** What the founder signs for a browser session: acting on one site, for the rest of the run. */
export const BROWSER_ACT: CommandRule = {
  describe:
    "Act in a real browser on this site — log in, type, click, submit — for the rest of this run.",
  id: "browser-act",
};

/**
 * Employee sessions load the founder's own CLI settings, so every MCP server the
 * founder connected for themselves — a browser, a mailbox, a chat workspace — is
 * in the employee's hands too, already signed in. None of it is a shell command,
 * so no rule above can see it.
 */
export const EXTERNAL_TOOL: CommandRule = {
  describe:
    "Use a tool connected in your own CLI settings (an MCP server, signed in as you) for the rest of this run.",
  id: "external-tool",
};

/** The MCP server behind a tool call titled `mcp__<server>__<tool>`, or null for anything else. */
export const externalServer = (title: string): string | null =>
  /^mcp__(?<server>.+?)__/u.exec(title)?.groups?.server ?? null;

/** The approval key and card text for using `server`. */
export const externalToolCommand = (server: string): string => `mcp: use ${server}`;

const LOOPBACK_URL = /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?:[:/]|$)|file:|about:)/u;

const BROWSER_CALL = new RegExp(
  AT_COMMAND + program("agent-browser") + String.raw`(?<args>[^\n;&|]*)`,
  "gu",
);

/** Verbs that change a page. Reading — open, read, snapshot, get, screenshot, scroll, wait — stays free. */
const BROWSER_WRITES =
  /(?:^|\s)(?:click|dblclick|type|fill|press|keyboard|check|uncheck|select|drag|upload|eval|find|mouse)(?:\s|$)/u;

const hostOf = (url: string): string | null => {
  try {
    return new URL(/^[a-z][a-z\d+.-]*:/iu.test(url) ? url : `https://${url}`).host || null;
  } catch {
    return null;
  }
};

/**
 * One run's view of the browser. A command names no site, only a verb, so the
 * watch remembers where each session was last pointed: acting on the team's own
 * localhost build is work, acting anywhere else is outward-facing. A page the
 * run never opened is unknown, and unknown asks.
 */
export class BrowserWatch {
  /** session → the remote host it is on; null is a local page */
  private pages = new Map<string, string | null>();
  private leased = new Set<string>();

  /** The host a command would act on without a lease, or null when it may run. */
  heldHost(command: string): string | null {
    for (const call of command.matchAll(BROWSER_CALL)) {
      const args = call.groups?.args ?? "";
      const session = /--session[=\s]+(?<name>\S+)/u.exec(args)?.groups?.name ?? "";
      const opened = /(?:^|\s)open\s+["']?(?<url>[^\s"']+)/u.exec(args)?.groups?.url;
      if (opened !== undefined) {
        this.pages.set(session, LOOPBACK_URL.test(opened) ? null : hostOf(opened));
      } else if (BROWSER_WRITES.test(args)) {
        const host = this.pages.has(session)
          ? this.pages.get(session)
          : "a page this run never opened";
        if (host !== null && host !== undefined && !this.leased.has(host)) {
          return host;
        }
      }
    }
    return null;
  }

  lease(host: string): void {
    this.leased.add(host);
  }
}

/** The approval key and card text for acting on `host`. */
export const browserActCommand = (host: string): string => `agent-browser: act on ${host}`;

/** True when every internet target named is the game's own loopback API. */
const onlyLoopbackTargets = (command: string): boolean => {
  const urls = command.match(/https?:\/\/[^\s"'`)]+/gu) ?? [];
  const remote = urls.filter((u) => !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])/u.test(u));
  if (remote.length > 0) {
    return false;
  }
  return urls.length > 0 || command.includes("$IDLEBIZ_API_URL");
};

export type CommandVerdict = { decision: "allow" } | { decision: "ask"; rule: CommandRule };

/** What the approval card says about a held command, by the rule that held it. */
export const describeRule = (id: string): string =>
  [...RULES, BROWSER_ACT, EXTERNAL_TOOL].find((rule) => rule.id === id)?.describe ??
  `Saved rule "${id}" is unavailable in this version.`;

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
