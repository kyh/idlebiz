/** How long to park when the message names no reset time. */
const DEFAULT_PARK_MS = 30 * 60_000;

/** Cap parses that land absurdly far out (clock skew, bad zone math). */
const MAX_PARK_MS = 12 * 3_600_000;

const LIMIT_PATTERNS = [
  /session limit/iu,
  /usage limit/iu,
  /rate.?limit/iu,
  /limit reached/iu,
  /overloaded_error/iu,
  /quota exceeded/iu,
];

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

/** Parse a CLI limit message into a reset time, defaulting when no time is readable. */
export const parseRateLimit = (
  text: string | undefined,
  now = new Date(),
): RateLimitInfo | null => {
  if (!text || !LIMIT_PATTERNS.some((p) => p.test(text))) {
    return null;
  }

  const relMs = relativeResetMs(text);
  if (relMs !== null) {
    return { resetsAt: now.getTime() + Math.min(relMs, MAX_PARK_MS) };
  }

  const at = absoluteResetAt(text, now);
  if (at !== null) {
    return { resetsAt: Math.min(at, now.getTime() + MAX_PARK_MS) };
  }

  return { resetsAt: now.getTime() + DEFAULT_PARK_MS };
};
