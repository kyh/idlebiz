// Domain shapes shared across main (control plane) and renderer (game UI).
// Pure types — safe to import anywhere.
//
// Identity: ids ARE agentcompanies/v1 slugs (URL-safe, human-readable). A
// company's id is its folder name under ~/.idlebiz; an employee's id is its
// folder name under agents/; a task's id is its folder name under tasks/.

/**
 * Which coding-agent CLI powers an employee. Employees run on the player's
 * own installed CLIs — a mixed roster is normal. The union is owned by
 * @repo/agent-driver (type-only re-export keeps this module renderer-safe);
 * use `isRunnerId` from the package where a runtime guard is needed.
 */
export type AgentRunner = import("@repo/agent-driver/runner").RunnerId;

/** Hard ceiling on team size — the LLM staffs freely underneath it. */
export const DEFAULT_MAX_AGENTS = 12;

// ---- blocked asks ------------------------------------------------------------
// Why a task is waiting on the founder. Structured end-to-end: a free-text
// question gets an answer box; an integration request renders a [Connect]
// button and the task auto-resumes once the founder connects.

export type IntegrationKind = "vercel" | "stripe";

export const INTEGRATION_LABELS = {
  vercel: "Vercel",
  stripe: "Stripe",
} satisfies Record<IntegrationKind, string>;

export type BlockedAsk =
  | { type: "question"; question: string }
  | { type: "integration"; integration: IntegrationKind; reason: string }
  | { type: "approval"; command: string };

// TASK.md keeps a single human-editable scalar; the marker syntax exists ONLY
// at this persistence boundary — everything in memory is the typed union.
export function serializeBlockedAsk(a: BlockedAsk): string {
  if (a.type === "question") return a.question;
  if (a.type === "approval") return `[approve] ${a.command}`;
  return `[connect:${a.integration}] ${a.reason}`;
}

export function parseBlockedAsk(s: string): BlockedAsk {
  const approval = /^\[approve\]\s*([\s\S]*)$/.exec(s);
  if (approval) return { type: "approval", command: (approval[1] ?? "").trim() };
  const m = /^\[connect:(vercel|stripe)\]\s*([\s\S]*)$/.exec(s);
  if (!m) return { type: "question", question: s };
  return {
    type: "integration",
    integration: m[1] === "vercel" ? "vercel" : "stripe",
    reason: (m[2] ?? "").trim(),
  };
}

// ---- command policy (founder sign-off) --------------------------------------

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
 * past the workspace, and `check:permissions` holds every rule to an example.
 *
 * Paths are the load-bearing heuristic for scope: employees work in relative
 * paths inside their workspace, so an absolute or `~` path in a destructive
 * command is the signal that something is reaching out of it.
 */
interface CommandRule {
  id: string;
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
const AT_COMMAND =
  String.raw`(?:^|[\n;&|(]|\$\(|` +
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
 * the policy, the stored ask, the approval card, the approval key — sees the
 * same canonical string. Without it a retry of the same action reads as a new
 * one and re-asks, and the founder is shown shell plumbing they did not write.
 */
export function normalizeCommand(command: string): string {
  return command
    .replace(/\s*2>&1/g, "")
    .replace(/\s*;\s*echo\s+["']?exit=\$\?["']?\s*$/, "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Key for "the founder already approved this exact action". Exact match on the
 * normalized form: a genuinely different command is a different decision.
 */
export function approvalKey(command: string): string {
  return normalizeCommand(command);
}

// ---- team-room mentions --------------------------------------------------------

/**
 * Resolve `@token` mentions against the roster: employee slug match first,
 * then exact first-name token (case-insensitive). Whole-token matching only —
 * `@sam` never wakes Samantha. Returns matched employee ids, deduped.
 */
export function resolveMentions(
  text: string,
  roster: readonly { id: string; name: string }[],
): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/@([\w-]+)/g)) {
    const token = (m[1] ?? "").toLowerCase();
    if (!token) continue;
    const bySlug = roster.find((e) => e.id.toLowerCase() === token);
    const byFirst = roster.filter((e) => e.name.split(/\s+/)[0]?.toLowerCase() === token);
    if (bySlug) ids.add(bySlug.id);
    else for (const e of byFirst) ids.add(e.id);
  }
  return [...ids];
}

export type TaskStatus =
  | "todo"
  | "queued"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "dead" // dead-letter: failed maxAttempts times, no longer auto-retried
  | "cancelled";
export type TaskPriority = "low" | "medium" | "high";
type EmployeeStatus = "idle" | "working";

// ---- queue reliability (TinyAGI-style retry/dead-letter) --------------------

/** How many times a task may run before it is dead-lettered. */
export const MAX_TASK_ATTEMPTS = 5;
const RETRY_BASE_MS = 15_000;
const RETRY_CAP_MS = 10 * 60_000;

/** Exponential backoff for the Nth failed attempt (1-based), capped. */
export function retryDelayMs(attempt: number): number {
  const d = RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(d, RETRY_CAP_MS);
}

// ---- business types (onboarding presets) -----------------------------------

interface BusinessTypeRoutine {
  name: string;
  intervalHours: number;
  role: string | null;
  instruction: string;
}

export interface BusinessType {
  id: "software" | "game-studio" | "vc" | "ecommerce" | "custom";
  label: string;
  emoji: string;
  pitchPlaceholder: string;
  hireHint: string;
  routine: BusinessTypeRoutine | null;
}

export const BUSINESS_TYPES: readonly BusinessType[] = [
  {
    id: "software",
    label: "Software company",
    emoji: "💻",
    pitchPlaceholder: "A delightful to-do app that makes planning feel effortless.",
    hireHint: "Lean product team: engineers, a designer, and someone on growth/marketing.",
    routine: null,
  },
  {
    id: "game-studio",
    label: "Game studio",
    emoji: "🎮",
    pitchPlaceholder: "A cozy pixel-art farming roguelike playable in the browser.",
    hireHint: "A game needs gameplay engineering, pixel art, sound, and game design.",
    routine: {
      name: "Playtest session",
      intervalHours: 24,
      role: "design",
      instruction:
        "Play the current build end to end. Log what's broken or unfun, then fix the worst issue or delegate it to the right teammate.",
    },
  },
  {
    id: "vc",
    label: "Venture capital firm",
    emoji: "💼",
    pitchPlaceholder:
      "A micro-VC that sources and writes investment memos on early-stage AI startups.",
    hireHint: "An investment firm needs sourcing, analysis/research, and investor-facing writing.",
    routine: {
      name: "Deal pipeline review",
      intervalHours: 24,
      role: "analy",
      instruction:
        "Review the pipeline docs in the workspace, source 3 new candidate companies, and write or refresh one investment memo.",
    },
  },
  {
    id: "ecommerce",
    label: "E-commerce business",
    emoji: "🛒",
    pitchPlaceholder: "An online store selling artist-designed enamel pins.",
    hireHint: "A shop needs product/merchandising, storefront engineering, ops, and marketing.",
    routine: {
      name: "Store audit",
      intervalHours: 24,
      role: "market",
      instruction:
        "Walk the storefront as a customer: product pages, copy, pricing, checkout. Improve the weakest page and draft one promotion.",
    },
  },
  {
    id: "custom",
    label: "Something else…",
    emoji: "✨",
    pitchPlaceholder: "A daily AI-curated newsletter for indie hackers.",
    hireHint: "",
    routine: null,
  },
];

export type BusinessTypeId = BusinessType["id"];

export function businessTypeById(id: BusinessTypeId): BusinessType {
  const found = BUSINESS_TYPES.find((b) => b.id === id);
  if (!found) throw new Error(`unknown business type ${id}`);
  return found;
}

// ---- budget (real token spend) ----------------------------------------------

/** Founder's AI spending budget. Infinite IS the off state — no third mode. */
export type Budget = { mode: "infinite" } | { mode: "capped"; capUsd: number };

export function isOutOfBudget(co: Company): boolean {
  return co.budget.mode === "capped" && co.spentUsd >= co.budget.capUsd;
}

export interface Company {
  id: string; // slug
  name: string;
  mission: string;
  businessType: BusinessTypeId;
  workspaceDir: string;
  founderName: string;
  founderSpriteSeed: string;
  autopilot: boolean; // when true, idle employees self-direct work (idle-game loop)
  maxAgents: number; // seat cap — the team lead hires/releases freely below it
  ships: number; // units of work the team has shipped
  revenueUsd: number | null; // REAL revenue (Stripe); null until a source is connected
  users: number | null; // REAL users (analytics); null until a source is connected
  budget: Budget; // founder-set cap on real AI spend
  spentUsd: number; // lifetime real token spend (USD)
  onboarded: boolean;
  createdAt: number;
}

export interface Employee {
  id: string; // slug (folder name under agents/)
  companyId: string;
  name: string;
  role: string;
  title: string;
  persona: string; // system-prompt flavor for the agent
  runner: AgentRunner; // which CLI executes this employee
  model: string | null; // model override; null = the CLI's own default
  sessionId: string | null;
  spriteSeed: string; // deterministic sprite + portrait
  deskIndex: number; // which desk slot in the office
  teamId: string | null; // which team this employee belongs to (TinyAGI-style)
  status: EmployeeStatus;
  createdAt: number;
}

/**
 * A named group of employees with a designated leader (TinyAGI-style team).
 * The leader receives direction and fans work out to / chains it through members;
 * everyone shares a persistent chat room they read and post to during runs.
 */
export interface Team {
  id: string; // slug (folder name under teams/)
  companyId: string;
  name: string;
  purpose: string; // what this team owns
  leaderId: string | null; // employee id of the team lead
  memberIds: string[]; // employee ids on this team (includes the leader)
  createdAt: number;
}

/** One message in a team's chat room. */
export interface TeamMessage {
  id?: number;
  teamId: string;
  fromEmployeeId: string | null; // null = system/founder
  text: string;
  createdAt: number;
}

export interface Task {
  id: string; // slug (folder name under tasks/)
  companyId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  runId: string | null;
  summary: string | null;
  blocked: BlockedAsk | null; // why this task awaits the founder (status "blocked")
  artifacts: string[]; // file paths the agent reported
  attempts: number; // failed runs so far (drives retry/dead-letter)
  nextAttemptAt: number | null; // earliest time a backoff retry may start
  lastError: string | null; // most recent failure message
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

/** A recurring directive: fires as a real task on a cadence (Paperclip-style heartbeat). */
export interface Routine {
  id: string; // slug (folder name under routines/)
  companyId: string;
  name: string;
  instruction: string;
  intervalHours: number;
  role: string | null; // preferred assignee role (substring match), else anyone idle
  lastRunAt: number | null;
}

export type ActivityKind =
  | "log"
  | "tool_call"
  | "status"
  | "lifecycle"
  | "thinking"
  | "message"
  | "chat"
  | "ship";

export interface ActivityEvent {
  id?: number;
  runId?: string | null;
  taskId?: string | null;
  employeeId?: string | null;
  kind: ActivityKind;
  message?: string | null;
  payload?: unknown;
  createdAt: number;
}
