/** The message of whatever was thrown — an Error's own, or the value spelled out. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no narrower honest type
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
