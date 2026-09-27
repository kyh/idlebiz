// What the approval card says about a held tool call, by the rule that held it.
// Data only, so the renderer names a hold without bundling the policy that judged it.

const HOLD_RULES = {
  // Leased for the rest of a run: what the founder signs is the site, not the keystroke.
  "browser-act":
    "Act in a real browser on this site — log in, type, click, submit — for the rest of this run.",
  // Signed for once and exactly: the page is a file, and the next could be any other.
  "browser-file":
    "Open a file from outside the workspace in a real browser — one run of exactly this command.",
  // Signed for like a shell command, once and exactly: no site can be named, so there is nothing to lease.
  "browser-unseen":
    "Act in a real browser on a page nobody could check first — one run of exactly this command.",
  deploy: "Deploy the product to a live, public URL.",
  // Leased for the rest of a run, like a site. No run loads the founder's MCP servers,
  // so this holds only one that slipped past that, signed in as the founder.
  "external-tool":
    "Use a tool connected in your own CLI settings (an MCP server, signed in as you) for the rest of this run.",
  "git-push": "Push commits to a remote repository.",
  "github-create": "Change something on GitHub — open, merge, comment on, edit or release.",
  "http-write": "Send data to a service on the internet.",
  payments: "Move real money or change records in your Stripe account.",
  "pipe-to-shell": "Download code from the internet and run it immediately.",
  "publish-package": "Publish a package to a public registry.",
  "read-credentials": "Read your stored credentials.",
  "remote-copy": "Copy files to another machine over the network.",
  "unknown-ask": "A tool call IdleBiz could not recognise — one run of exactly this.",
} satisfies Record<string, string>;

export type HoldRuleId = keyof typeof HOLD_RULES;

const LEASED: ReadonlySet<string> = new Set<HoldRuleId>(["browser-act", "external-tool"]);

/** Whether signing an ask under this rule covers the rest of the run rather than one run of it. */
export const isLeased = (rule: string): boolean => LEASED.has(rule);

/** What the founder signs for by approving an ask under this rule. */
export const approvalScope = (rule: string): string =>
  isLeased(rule)
    ? "Approving covers this for the rest of this run."
    : "Approving covers exactly this, once.";

const TEXT = new Map<string, string>(Object.entries(HOLD_RULES));

/** A saved ask names its rule as text, and may name one this version no longer has. */
export const describeRule = (id: string): string =>
  TEXT.get(id) ?? `Saved rule "${id}" is unavailable in this version.`;

// A direction override or a zero-width character in the key would let the card show one
// command while the founder signs another, so each is shown by its code point.
const HIDDEN = /[\p{Cc}\p{Cf}]/gu;

/** A held ask's key as its card shows it: every control or format character named, none obeyed. */
export const shownKey = (key: string): string =>
  key.replaceAll(
    HIDDEN,
    (char) => `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`,
  );
