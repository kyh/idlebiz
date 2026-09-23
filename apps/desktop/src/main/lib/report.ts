/**
 * Record a fault that is caught so the work can go on. Main's console is its
 * log file (`initLog`), so this is what a Finder-launched app leaves behind.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no narrower honest type
export const report = (where: string, error: unknown): void => {
  console.error(`[${where}]`, error);
};
