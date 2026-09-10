// Reuse Intl instances; display times in the founder's local zone.

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat();

/** "4:30 PM" from an epoch-ms timestamp. */
export const formatTime = (epoch: number): string => timeFmt.format(epoch);

export const formatDate = (epoch: number): string => dateFmt.format(epoch);

const compactFmt = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  notation: "compact",
});

/** "1.2k", "3.4M" — a scoreboard number. */
export const formatCompact = (n: number): string => compactFmt.format(n);

/** "$12.34" — money the founder is spending, always to the cent. */
export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`;

export const napLabel = (until: number): string => `☕ resting til ${formatTime(until)}`;

/** When the office wakes: the earliest of the runners' usage-limit resets still ahead. */
export const earliestReset = (
  resting: Readonly<Partial<Record<string, number>>>,
  now: number,
): number | undefined =>
  Object.values(resting)
    .filter((t): t is number => t !== undefined && t > now)
    .toSorted((a, b) => a - b)[0];

export const spentLabel = (spentUsd: number): string => `spent ${formatUsd(spentUsd)}`;

/** "3 runs", "1 question" — a count with its noun, the locale's plural rules. */
export const plural = (n: number, noun: string): string =>
  `${n} ${noun}${new Intl.PluralRules().select(n) === "one" ? "" : "s"}`;

const unitFmt = (unit: "minute" | "hour" | "day"): Intl.NumberFormat =>
  new Intl.NumberFormat(undefined, { style: "unit", unit, unitDisplay: "long" });
const away = { day: unitFmt("day"), hour: unitFmt("hour"), minute: unitFmt("minute") };

/** "45 minutes", "3 hours", "2 days" — how long the founder was away, in the largest unit that fits. */
export const formatAway = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return away.minute.format(minutes);
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? away.hour.format(hours) : away.day.format(Math.round(hours / 24));
};

const listFmt = new Intl.ListFormat(undefined, { style: "long", type: "conjunction" });
/** "Mira, Bo and Ada". */
export const formatNames = (names: readonly string[]): string => listFmt.format(names);
