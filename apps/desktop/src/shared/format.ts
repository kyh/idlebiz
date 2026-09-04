// Shared display formatters. Built once at module scope instead of per render —
// constructing an Intl.DateTimeFormat is the expensive part, and the HUD's nap
// label re-renders on every activity event.
//
// Deliberately no fixed `timeZone`: these are wall-clock times the founder reads
// against their own day ("resting til 4:30 PM"). Single-window Electron, no SSR,
// so there is no server/client render to keep in sync.

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat();

/** "4:30 PM" from an epoch-ms timestamp. */
export const formatTime = (epoch: number): string => timeFmt.format(epoch);

/** Short calendar date from an epoch-ms timestamp. */
export const formatDate = (epoch: number): string => dateFmt.format(epoch);

const compactFmt = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** "1.2k", "3.4M" — a scoreboard number. */
export const formatCompact = (n: number): string => compactFmt.format(n);

/** "$12.34" — money the founder is spending, always to the cent. */
export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`;

/** The office naps until a CLI's usage limit lifts. */
export const napLabel = (until: number): string => `☕ resting til ${formatTime(until)}`;
