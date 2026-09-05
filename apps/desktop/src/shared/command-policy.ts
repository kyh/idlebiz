// ---------------------------------------------------------------------------
// The command policy: which of an employee's commands need the founder's
// sign-off. Shared by main (the permission gate) and the renderer (the
// approval card names the rule). Pure; every rule owes command-policy.test.ts
// an example it catches and one it lets through.
// ---------------------------------------------------------------------------

/**
 * The single decision point for what an employee may do unattended, applied
 * identically to both runners.
 *
 * It lives here rather than leaning on either CLI's own safeguards because
 * those are not the same shape: claude has a classifier (`--permission-mode
 * auto`), codex has an OS sandbox, and neither knows what this game considers
 * the founder's business. A PreToolUse hook sends every shell command here,
 * so this is the one place with a complete view of both.
 *
 * It is a floor, not the whole story — the CLIs' own protections still sit
 * underneath. And it fails OPEN by construction: anything unmatched runs. So
 * a rule earns its place by catching something whose blast radius reaches
 * past the workspace, and command-policy.test.ts holds every rule to an example.
 *
 * Paths are the load-bearing heuristic for scope: employees work in relative
 * paths inside their workspace, so an absolute or `~` path in a destructive
 * command is the signal that something is reaching out of it.
 */
/** Every reason a command can be held, named — the ask persists the id, the card looks it up. */
export const RULE_IDS = [
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
  id: RuleId;
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

/**
 * A shell position where a program name can actually appear: the start of the
 * line, after an operator, or behind a wrapper like npx/sudo/env.
 *
 * Every rule anchors its program here, because matching the bare name anywhere
 * in the string reads quoted argument text as if it were a command. That is
 * not hypothetical: an employee whose `git push` was held then tried to post
 * "I ran git push and it was blocked" to the team room, and the words inside
 * that JSON payload tripped the git-push rule all over again — so the report
 * of a block was itself blocked, and it replaced the real ask on the card.
 *
 * It is an anchor, not a shell parser: separators are matched regardless of
 * quoting, so a separator *inside* a quoted argument still opens a command
 * position. Real parsing is the fix if false positives ever bite; the gate
 * fails open and the CLIs' own protections sit underneath, so this is a floor.
 */
// A bare `(` is deliberately NOT a command position. Subshells are vanishingly
// rare in agent commands, while prose inside a quoted payload is not: an
// employee's own delegate call carrying "(`npm ci`)" and "do NOT npm publish"
// in its JSON body was held as if it were publishing a package. Command
// substitution still opens one, via `$(` and backticks below.
const AT_COMMAND =
  String.raw`(?:^|[\n;&|]|\$\(|` +
  "`" +
  String.raw`)\s*(?:(?:sudo|command|env|time|nohup|npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|npm\s+exec)\s+)*(?:--?[\w-]+\s+)*(?:[\w_]+=\S+\s+)*`;

/** Anchor a program pattern to a real invocation site. */
const invocation = (program: string): RegExp => new RegExp(AT_COMMAND + program);

const RULES: readonly Rule[] = [
  {
    id: "deploy",
    // `vercel` with no subcommand deploys, so this gates the tool and carves
    // out the read-only subcommands rather than listing deploy verbs — the
    // verb list missed `vercel --prod --yes`, the most natural way to ship.
    describe: "Deploy the product to a live, public URL.",
    match: invocation(
      String.raw`(?:vercel|netlify|wrangler|fly|railway|surge)\b(?!\s+${DEPLOY_TOOL_READS}\b)`,
    ),
  },
  {
    id: "publish-package",
    describe: "Publish a package to a public registry.",
    match: invocation(String.raw`(?:npm|pnpm|yarn|bun)\b[^|;&]*\bpublish\b`),
  },
  {
    id: "git-push",
    // git accepts global options before the subcommand (`git -C dir push`).
    // Known gap: a quoted option value containing spaces (`-c k='a b'`) breaks
    // the scan — that needs a parser, not a wider regex.
    describe: "Push commits to a remote repository.",
    match: invocation(
      String.raw`git\b(?:\s+-[a-zA-Z-]+(?:=\S+)?(?:\s+(?!push\b)-?\S+)?)*\s+push\b`,
    ),
  },
  {
    id: "github-create",
    describe: "Create something public on GitHub (PR, release, repo, or issue).",
    match: invocation(
      String.raw`gh\s+(?:(?:pr|release|repo|issue|gist)\s+create\b` +
        String.raw`|api\b[^|;&]*(?:\s-X\s*|\s--method[=\s])(?:POST|PUT|PATCH|DELETE)\b)`,
    ),
  },
  {
    id: "payments",
    describe: "Move real money through Stripe.",
    match: invocation(
      String.raw`stripe\b[^|;&]*\b(?:create|charge|payouts?|refunds?|transfers?)\b`,
    ),
  },
  {
    id: "http-write",
    describe: "Send data to a service on the internet.",
    match: invocation(
      String.raw`(?:curl\b[^|;&]*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b` +
        // --json is shorthand for --data-binary + headers; -F/-T upload files
        String.raw`|\s(?:--data|--data-raw|--data-binary|--data-urlencode|--json|--form|--upload-file|-d|-F|-T)[\s=])` +
        String.raw`|wget\b[^|;&]*\s(?:--post-data|--post-file|--method[=\s]*(?:POST|PUT|PATCH|DELETE))\b)`,
    ),
    networked: true,
  },
  {
    id: "remote-copy",
    describe: "Copy files to another machine over the network.",
    match: invocation(
      String.raw`(?:(?:scp|rsync)\b[^|;&]*\s[\w.-]+@[\w.-]+:|ssh\s+[\w.-]+@[\w.-]+)`,
    ),
    networked: true,
  },
  {
    id: "pipe-to-shell",
    describe: "Download code from the internet and run it immediately.",
    match: invocation(String.raw`(?:curl|wget)\b[^;&]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|python3?)\b`),
    networked: true,
  },
  {
    id: "read-credentials",
    describe: "Read your stored credentials.",
    match: invocation(
      String.raw`(?:(?:cat|less|more|head|tail|strings|grep|cp|base64|openssl)\b[^|;&]*${ESCAPES}/\.(?:ssh|aws|gnupg|config/gh)\b` +
        String.raw`|security\s+find-(?:generic|internet)-password\b)`,
    ),
  },
  {
    id: "destructive-outside",
    describe: "Irreversibly delete or overwrite files outside the workspace.",
    match: invocation(String.raw`(?:rm|shred|truncate)\b[^|;&]*\s-?[\w-]*\s*${ESCAPES}`),
  },
  {
    id: "write-outside",
    describe: "Change files or permissions outside the workspace.",
    match: invocation(String.raw`(?:chmod|chown|mv|dd\s+of=|tee)\b[^|;&]*${ESCAPES}`),
  },
];

/** True when every internet target named is the game's own loopback API. */
function onlyLoopbackTargets(command: string): boolean {
  const urls = command.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
  const remote = urls.filter((u) => !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])/.test(u));
  if (remote.length > 0) return false;
  return urls.length > 0 || command.includes("$IDLEBIZ_API_URL");
}

export type CommandVerdict = { decision: "allow" } | { decision: "ask"; rule: CommandRule };

/** What the approval card says about a held command, by the rule that held it. */
export function describeRule(id: RuleId): string {
  return RULES.find((rule) => rule.id === id)?.describe ?? "Wants to run this.";
}

export function classifyCommand(command: string): CommandVerdict {
  for (const rule of RULES) {
    if (!rule.match.test(command)) continue;
    if (rule.networked && onlyLoopbackTargets(command)) continue;
    return { decision: "ask", rule };
  }
  return { decision: "allow" };
}

/**
 * Strip the plumbing the CLIs wrap around a command before running it
 * (`… 2>&1; echo "exit=$?"`) and collapse whitespace.
 *
 * Applied once where a command enters the game, so everything downstream —
 * the policy, the stored ask, the approval card — sees the same canonical
 * string, which is also the key for "the founder already approved this exact
 * action". Without it a retry of the same action reads as a new one and
 * re-asks, and the founder is shown shell plumbing they did not write.
 */
export function normalizeCommand(command: string): string {
  return command
    .replace(/\s*2>&1/g, "")
    .replace(/\s*;\s*echo\s+["']?exit=\$\?["']?\s*$/, "")
    .trim()
    .replace(/\s+/g, " ");
}
