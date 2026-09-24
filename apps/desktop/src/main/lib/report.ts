/**
 * Record a fault that is caught so the work can go on. Main's console is its
 * log file (`initLog`), so this is what a Finder-launched app leaves behind.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no narrower honest type
export const report = (where: string, error: unknown): void => {
  console.error(`[${where}]`, error);
};

/** Run a step whose fault must not stop the work after it: the fault is reported, and the caller goes on. */
export const guarded = (where: string, step: () => void): void => {
  try {
    step();
  } catch (error) {
    report(where, error);
  }
};
