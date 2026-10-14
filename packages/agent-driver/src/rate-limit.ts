import { RequestError } from "@agentclientprotocol/sdk";
import { z } from "zod";

// What a provider failure says of the runner it happened on, read from the structured kinds the
// adapters attach before ever reading the agent's prose: claude-agent-acp rejects a prompt with
// `data.errorKind` and reports its rate limit on usage updates (`_claude/rateLimit`); codex-acp
// ends a turn on a typed session failure whose category and actions say what clears it. Prose
// is read only where no structure says more: claude flags a usage limit by its text's prefix
// apart from errorKind, and codex-acp types an overload exactly as its catch-all service failure.

/**
 * How a failed turn bears on its runner: a login no retry clears, a refusal of access no sign-in
 * repairs (an organization yet to verify, a cloud credential claude could not load), a usage
 * limit that lifts at a known or guessed time, a provider too busy for now, a session out of
 * room, or anything else, which is only the task's.
 */
export const FAILURE_CLASSES = [
  "auth",
  "access-denied",
  "usage-limit",
  "overloaded",
  "context",
  "other",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** claude-agent-acp's `errorKind` values (the SDK's assistant message errors). */
const CLAUDE_ERROR_KINDS = [
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "cloud_credential_error",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "unknown",
  "max_output_tokens",
] as const;

/**
 * What each of claude's kinds says of the runner; one this build does not know is `other`.
 * Mirrors claude-agent-acp's `providerFailureCategory` (dist/session-failure-extension.js):
 * recheck it whenever the adapter is bumped.
 */
const CLAUDE_KIND_CLASS = {
  account_on_hold: "usage-limit",
  authentication_failed: "auth",
  billing_error: "usage-limit",
  cloud_credential_error: "access-denied",
  invalid_request: "other",
  max_output_tokens: "context",
  model_not_found: "other",
  oauth_org_not_allowed: "auth",
  overloaded: "overloaded",
  rate_limit: "usage-limit",
  server_error: "other",
  unknown: "other",
  verification_required: "access-denied",
} as const satisfies Record<(typeof CLAUDE_ERROR_KINDS)[number], FailureClass>;

/** What claude-agent-acp puts in a rejected prompt's data. */
const ClaudeErrorData = z.object({ errorKind: z.enum(CLAUDE_ERROR_KINDS) });

/** What ACP answers when a sign-in is needed, as the SDK numbers it. */
const AUTH_REQUIRED = RequestError.authRequired().code;

const OVERLOAD_PATTERNS = [/model is at capacity/iu, /overloaded/iu];

const USAGE_LIMIT_PATTERNS = [
  /session limit/iu,
  /usage limit/iu,
  /rate.?limit/iu,
  /limit reached/iu,
  /quota exceeded/iu,
  /you['’]ve (?:hit|reached) your/iu,
  /out of (?:extra )?usage/iu,
];

/** What the agent's own `text` tells of: an overload, a usage limit, or neither. */
export const classOfText = (text: string): FailureClass => {
  if (OVERLOAD_PATTERNS.some((p) => p.test(text))) {
    return "overloaded";
  }
  return USAGE_LIMIT_PATTERNS.some((p) => p.test(text)) ? "usage-limit" : "other";
};

/**
 * What an agent's rejection of a prompt says of its runner: ACP's sign-in code, else claude's
 * `errorKind`, else, where that names nothing of the runner, the agent's own message.
 */
export const classOfRequestError = (error: RequestError): FailureClass => {
  if (error.code === AUTH_REQUIRED) {
    return "auth";
  }
  const data = ClaudeErrorData.safeParse(error.data);
  const structured = data.success ? CLAUDE_KIND_CLASS[data.data.errorKind] : "other";
  return structured === "other" ? classOfText(error.message) : structured;
};

/** codex-acp's typed session failure, as far as its class goes. */
export interface TypedFailure {
  category: string;
  actions: readonly string[];
  /** Its title, and details when it has any. */
  text: string;
}

/**
 * What a typed failure says of its runner. A limit only a new session clears is the session's;
 * any other limit (a quota, a rate limit) is the runner's. A service fault is an overload or a
 * limit only when its text says so: codex-acp types an overload exactly as its catch-all for every
 * error it cannot place, which it did not retry, and resting on one of those would retry a
 * deterministic fault forever.
 */
export const classOfTypedFailure = ({ actions, category, text }: TypedFailure): FailureClass => {
  if (category === "access" && actions.includes("login")) {
    return "auth";
  }
  if (category === "limit") {
    return actions.includes("new_session") ? "context" : "usage-limit";
  }
  return category === "service" ? classOfText(text) : "other";
};

/** The first rest an overload or a refusal of access earns; each one after it in a row doubles it. */
export const OVERLOAD_BACKOFF_MS = 60_000;

/** The longest an overload or a refusal of access rests a runner: a busy provider, or a credential blip, clears in minutes. */
const MAX_OVERLOAD_BACKOFF_MS = 15 * 60_000;

/** How long the `streak`-th overload or refusal of access in a row rests its runner: 1m, 2m, 4m… up to 15m. */
export const overloadBackoffMs = (streak: number): number =>
  Math.min(OVERLOAD_BACKOFF_MS * 2 ** Math.max(0, streak - 1), MAX_OVERLOAD_BACKOFF_MS);

/** How long to park on a usage limit when nothing names a reset time. */
const DEFAULT_PARK_MS = 30 * 60_000;

/** Cap parses that land absurdly far out (clock skew, bad zone math). */
const MAX_PARK_MS = 12 * 3_600_000;

/** claude-agent-acp's rate limit, as it rides a usage update's `_meta`. */
const ClaudeRateLimitMeta = z.object({
  "_claude/rateLimit": z.object({
    resetsAt: z.number().optional(),
    status: z.string(),
  }),
});

// Epoch seconds as the CLI reports them; a value already in milliseconds is taken as it is.
const epochMs = (at: number): number => (at < 1e12 ? at * 1000 : at);

/**
 * What a usage update's `meta` says of claude's rate limit: the epoch ms it lifts at while it
 * refuses requests, null once it allows them again, or undefined when it says nothing of it.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- an extension's `_meta` has no narrower honest type
export const rateLimitResetIn = (meta: unknown): number | null | undefined => {
  const parsed = ClaudeRateLimitMeta.safeParse(meta);
  if (!parsed.success) {
    return undefined;
  }
  const { resetsAt, status } = parsed.data["_claude/rateLimit"];
  if (status !== "rejected") {
    return null;
  }
  // still refusing with no reset named: say nothing, so a reset an earlier update named stands
  return resetsAt === undefined ? undefined : epochMs(resetsAt);
};

/** Wall-clock minutes in an IANA zone; null for an unknown zone. */
const minutesOfDayIn = (zone: string, at: Date): number | null => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      minute: "numeric",
      timeZone: zone,
    }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) {
      return null;
    }
    return (h % 24) * 60 + m;
  } catch {
    return null;
  }
};

/** Next epoch at which the zone's wall clock reads `targetMinutes` of day. */
const nextWallClock = (targetMinutes: number, zone: string, now: Date): number | null => {
  const current = minutesOfDayIn(zone, now);
  if (current === null) {
    return null;
  }
  const deltaMin = (targetMinutes - current + 24 * 60) % (24 * 60);
  return now.getTime() + (deltaMin === 0 ? 24 * 60 : deltaMin) * 60_000;
};

/** "in 4 days 21 hours 29 minutes" / "in 2 hours 15 minutes" / "in 45 minutes" — ms from now, or null. */
const relativeResetMs = (text: string): number | null => {
  const rel =
    /\bin\s+(?=\d)(?:(?<days>\d+)\s*d(?:ays?)?)?\s*(?:(?<hours>\d+)\s*h(?:ours?|rs?)?)?\s*(?:(?<minutes>\d+)\s*m(?:in(?:ute)?s?)?)?/iu.exec(
      text,
    );
  const days = Number(rel?.groups?.days ?? 0);
  const hours = Number(rel?.groups?.hours ?? 0);
  const minutes = Number(rel?.groups?.minutes ?? 0);
  const ms = ((days * 24 + hours) * 60 + minutes) * 60_000;
  return ms > 0 ? ms : null;
};

/** "resets 10:30pm (America/Los_Angeles)" / "try again at 3 am" — epoch ms, or null. */
const absoluteResetAt = (text: string, now: Date): number | null => {
  const abs =
    /(?:resets?|try again)(?:\s+at)?\s+(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)/iu.exec(
      text,
    );
  if (!abs) {
    return null;
  }
  let hour = Number(abs.groups?.hour) % 12;
  if ((abs.groups?.meridiem ?? "").toLowerCase() === "pm") {
    hour += 12;
  }
  const minutesOfDay = hour * 60 + Number(abs.groups?.minute ?? 0);
  const zone = /\((?<zone>[A-Za-z_]+\/[A-Za-z_]+)\)/u.exec(text)?.groups?.zone;
  return nextWallClock(minutesOfDay, zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, now);
};

/** When the text says the limit lifts, or null when it names no time. */
const resetNamedIn = (text: string, now: Date): number | null => {
  const relMs = relativeResetMs(text);
  return relMs === null ? absoluteResetAt(text, now) : now.getTime() + relMs;
};

/**
 * When a usage limit lifts: the reset the provider reported (`reported`, epoch ms) while it is
 * still ahead, else the time the agent's `text` names, else a default park; never past the cap.
 */
export const liftsAt = (text: string, now = new Date(), reported: number | null = null): number => {
  const at =
    reported !== null && reported > now.getTime()
      ? reported
      : (resetNamedIn(text, now) ?? now.getTime() + DEFAULT_PARK_MS);
  return Math.min(at, now.getTime() + MAX_PARK_MS);
};
