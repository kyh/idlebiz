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
  "destructive-outside": "Irreversibly delete or overwrite files outside the workspace.",
  // Leased for the rest of a run, like a site. Employee sessions load the founder's
  // own CLI settings, so every MCP server the founder connected for themselves — a
  // browser, a mailbox, a chat workspace — is in the employee's hands too, already signed in.
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
  // Signed for once and exactly, never leased: a widened sandbox already lets every later command in the run skip asking.
  "sandbox-widen":
    "Let this run reach the internet or write outside its workspace without asking again, for every command until the run ends.",
  // Never leased: the save is what IdleBiz reads back as the company's truth.
  "save-edit":
    "Edit the company's save files directly — tasks, bets, approvals, teammates' instructions.",
  "unknown-ask": "A tool call IdleBiz could not recognise — one run of exactly this.",
  "write-outside": "Change files or permissions outside the workspace.",
} satisfies Record<string, string>;

export type HoldRuleId = keyof typeof HOLD_RULES;

const TEXT = new Map<string, string>(Object.entries(HOLD_RULES));

/** A saved ask names its rule as text, and may name one this version no longer has. */
export const describeRule = (id: string): string =>
  TEXT.get(id) ?? `Saved rule "${id}" is unavailable in this version.`;
