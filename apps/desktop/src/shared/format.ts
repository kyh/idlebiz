// Reuse Intl instances; display times in the founder's local zone.

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat();

/** "4:30 PM" from an epoch-ms timestamp. */
export const formatTime = (epoch: number): string => timeFmt.format(epoch);

export const formatDate = (epoch: number): string => dateFmt.format(epoch);

const compactFmt = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** "1.2k", "3.4M" — a scoreboard number. */
export const formatCompact = (n: number): string => compactFmt.format(n);

/** "$12.34" — money the founder is spending, always to the cent. */
export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`;

export const napLabel = (until: number): string => `☕ resting til ${formatTime(until)}`;

/** When the office wakes: the earliest of the runners' usage-limit resets still ahead. */
export function earliestReset(
  resting: Readonly<Partial<Record<string, number>>>,
  now: number,
): number | undefined {
  return Object.values(resting)
    .filter((t): t is number => t !== undefined && t > now)
    .toSorted((a, b) => a - b)[0];
}

export const spentLabel = (spentUsd: number): string => `spent ${formatUsd(spentUsd)}`;
