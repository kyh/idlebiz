/** The message of whatever was thrown — an Error's own, or the value spelled out. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no narrower honest type
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A request the caller can fix; its message is safe to echo back. */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}
