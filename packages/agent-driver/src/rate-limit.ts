// Subscription CLIs hit usage/session limits in normal play — the single
// most common real-world run failure. Detect it from the error text and
// recover the reset time so the caller can PARK work instead of burning
// retries on a wall that won't move.

/** How long to park when the message names no reset time. */
const DEFAULT_PARK_MS = 30 * 60_000;

/** Cap parses that land absurdly far out (clock skew, bad zone math). */
const MAX_PARK_MS = 12 * 3_600_000;

const LIMIT_PATTERNS = [
  /session limit/i,
  /usage limit/i,
  /rate.?limit/i,
  /limit reached/i,
  /overloaded_error/i,
  /quota exceeded/i,
];

export interface RateLimitInfo {
  /** Epoch ms when the limit lifts (best effort; defaulted when unparseable). */
  resetsAt: number;
}

/**
 * Current wall-clock minutes-of-day in an IANA zone, via Intl — avoids any
 * hand-rolled offset math. Returns null for an unknown zone.
 */
function minutesOfDayIn(zone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return (h % 24) * 60 + m;
  } catch {
    return null;
  }
}

/** Next epoch at which the zone's wall clock reads `targetMinutes` of day. */
function nextWallClock(targetMinutes: number, zone: string, now: Date): number | null {
  const current = minutesOfDayIn(zone, now);
  if (current === null) return null;
  const deltaMin = (targetMinutes - current + 24 * 60) % (24 * 60);
  return now.getTime() + (deltaMin === 0 ? 24 * 60 : deltaMin) * 60_000;
}

/**
 * Detect a usage/session/rate limit in a run's error text. Understands the
 * CLIs' human formats — "resets 10:30pm (America/Los_Angeles)",
 * "try again at 3am", "try again in 2 hours 15 minutes" — and falls back to
 * a default park window when only the fact of the limit is recognizable.
 */
export function parseRateLimit(text: string | undefined, now = new Date()): RateLimitInfo | null {
  if (!text || !LIMIT_PATTERNS.some((p) => p.test(text))) return null;

  // "in 2 hours 15 minutes" / "in 45 minutes" / "in 1 hour"
  const rel = /\bin\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(text);
  if (rel && (rel[1] || rel[2])) {
    const ms = (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000;
    if (ms > 0) return { resetsAt: now.getTime() + Math.min(ms, MAX_PARK_MS) };
  }

  // "resets 10:30pm (America/Los_Angeles)" / "try again at 3 am"
  const abs = /(?:resets?|try again)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (abs) {
    let hour = Number(abs[1]) % 12;
    if ((abs[3] ?? "").toLowerCase() === "pm") hour += 12;
    const minutes = hour * 60 + Number(abs[2] ?? 0);
    const zone = /\(([A-Za-z_]+\/[A-Za-z_]+)\)/.exec(text)?.[1];
    const at = nextWallClock(
      minutes,
      zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      now,
    );
    if (at !== null) {
      return { resetsAt: Math.min(at, now.getTime() + MAX_PARK_MS) };
    }
  }

  return { resetsAt: now.getTime() + DEFAULT_PARK_MS };
}
