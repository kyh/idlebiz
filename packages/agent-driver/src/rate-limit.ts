import { RequestError } from "@agentclientprotocol/sdk";
import { z } from "zod";

/** How long to park when the message names no reset time. */
const DEFAULT_PARK_MS = 30 * 60_000;

/** Cap parses that land absurdly far out (clock skew, bad zone math). */
const MAX_PARK_MS = 12 * 3_600_000;

// claude-agent-acp flags a usage limit by its text's prefix, apart from errorKind, so the
// agent's own message is read too. An overload parks as well: retried at once, every
// task on the runner would be dead-lettered within minutes.
const LIMIT_PATTERNS = [
  /session limit/iu,
  /usage limit/iu,
  /rate.?limit/iu,
  /limit reached/iu,
  /overloaded_error/iu,
  /quota exceeded/iu,
  /you['’]ve (?:hit|reached) your/iu,
  /out of (?:extra )?usage/iu,
];

/** claude's `errorKind` values that stop every task on the runner, not just this one. */
const LIMIT_KINDS = new Set(["rate_limit", "billing_error", "overloaded"]);

/** What claude-agent-acp (`errorKind`) and codex-acp (`codexErrorInfo`, `message`) put in a rejected prompt's data. */
const LimitData = z.object({
  codexErrorInfo: z.unknown().optional(),
  errorKind: z.string().optional(),
  message: z.string().optional(),
});

export interface RateLimitInfo {
  /** Epoch ms when the limit lifts (best effort; defaulted when unparseable). */
  resetsAt: number;
}

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

/** "in 2 hours 15 minutes" / "in 45 minutes" / "in 1 hour" — ms from now, or null. */
const relativeResetMs = (text: string): number | null => {
  const rel =
    /\bin\s+(?:(?<hours>\d+)\s*h(?:ours?|rs?)?)?\s*(?:(?<minutes>\d+)\s*m(?:in(?:ute)?s?)?)?/iu.exec(
      text,
    );
  const hours = rel?.groups?.hours;
  const minutes = rel?.groups?.minutes;
  if (!hours && !minutes) {
    return null;
  }
  const ms = (Number(hours ?? 0) * 60 + Number(minutes ?? 0)) * 60_000;
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
 * The usage limit an agent refused a request for, or null. Only the agent's own
 * rejection counts: a watchdog's or a crash's text is never read as a limit.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no narrower honest type
export const limitOf = (error: unknown, now = new Date()): RateLimitInfo | null => {
  if (!(error instanceof RequestError)) {
    return null;
  }
  const parsed = LimitData.safeParse(error.data);
  const data = parsed.success ? parsed.data : {};
  const limited =
    (data.errorKind !== undefined && LIMIT_KINDS.has(data.errorKind)) ||
    data.codexErrorInfo === "usageLimitExceeded" ||
    LIMIT_PATTERNS.some((p) => p.test(error.message));
  if (!limited) {
    return null;
  }
  // codex's message is the bare "Internal error"; its readable text is in the data
  const named =
    resetNamedIn(error.message, now) ??
    (data.message === undefined ? null : resetNamedIn(data.message, now));
  return {
    resetsAt: Math.min(named ?? now.getTime() + DEFAULT_PARK_MS, now.getTime() + MAX_PARK_MS),
  };
};
