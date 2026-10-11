import type { ToolAsk } from "@repo/agent-driver/tool-ask";
import type { HoldRuleId } from "@repo/domain/hold-rules";
import { heldBrowserAct } from "./browser";
import type { Confinement, LivePage } from "./browser";
import { pipelinesOf } from "./reading";
import type { Call } from "./reading";
import { RULE_PROGRAMS, ruleHolding } from "./shell-rules";
import type { Rule } from "./shell-rules";

// IdleBiz answers every permission ask both runners raise, so an unmatched command runs
// with the founder's privileges, less what the run's Seatbelt profile seals (their logins,
// IdleBiz's keys, every write outside the run's own folders): the CLIs' own sandboxes are
// off, and no rule judges where a run writes. It is a tripwire for outward actions, not a
// sandbox: what a script runs stays unseen, so `npm run deploy` or a script on disk goes
// through.

/** What a shell command runs, read once for the rules and the browser gate alike. */
const callsOf = (command: string): Call[][] => pipelinesOf(command, RULE_PROGRAMS);

export type CommandVerdict = { decision: "allow" } | { decision: "ask"; rule: Rule };

export const classifyCommand = (command: string): CommandVerdict => {
  const rule = ruleHolding(callsOf(command));
  return rule === undefined ? { decision: "allow" } : { decision: "ask", rule };
};

/** What a tool call waits on: the approval the founder signs, under the rule that says whether signing covers the rest of the run. */
export interface Hold {
  /** The approval key, and the text on the founder's card. */
  key: string;
  rule: HoldRuleId;
}

/** One line, so the key reads back the same from the task's saved ask. */
const oneLine = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

/**
 * What the founder may be asked to sign. A widening of codex's own sandbox never is: once
 * signed, every later command in the run would stop asking, so the run refuses it unasked.
 */
export type JudgedAsk = Exclude<ToolAsk, { kind: "sandbox" }>;

/**
 * The one judgement every tool call passes through; null lets it run. `leases` is
 * what this run was already signed for, `confinement` its own folders.
 */
export const holdFor = async (
  tool: JudgedAsk,
  leases: ReadonlySet<string>,
  livePage: LivePage,
  confinement: Confinement,
): Promise<Hold | null> => {
  if (tool.kind === "mcp") {
    if (tool.server === null) {
      // signed for call by call: a lease on "unknown" would cover every such server
      return { key: "mcp: use a tool nothing could name", rule: "unknown-ask" };
    }
    const key = `mcp: use ${tool.server}`;
    return leases.has(key) ? null : { key, rule: "external-tool" };
  }
  if (tool.kind === "edit") {
    // the seal refuses a write outside the run's own folders, whichever tool makes it
    return null;
  }
  if (tool.kind === "network") {
    // the command behind it goes unseen, so nothing tells a read from a send
    const key = `network: reach ${tool.host ?? "a host nobody named"}`;
    return { key, rule: "http-write" };
  }
  if (tool.kind === "fetch") {
    // a read, as a bare `curl <url>` is: the shell rules hold only what sends
    return null;
  }
  if (tool.kind === "read") {
    // as a bare `cat` is: the seal keeps what no run may read
    return null;
  }
  if (tool.kind === "unknown") {
    const key = oneLine(`ask: ${tool.title || "a tool call nothing named"}`);
    return { key, rule: "unknown-ask" };
  }
  // Keyed as sent, so the card shows the program that runs, newlines and all; trimmed, as the
  // task's saved ask reads back.
  const key = tool.command.trim();
  const pipelines = callsOf(tool.command);
  const rule = ruleHolding(pipelines);
  if (rule !== undefined) {
    return { key, rule: rule.id };
  }
  return await heldBrowserAct(pipelines, key, leases, livePage, confinement);
};
