// Two guards for a renderer that mirrors main's state by asking for it again.

export interface Order {
  /** Taken when a request starts. */
  ticket: () => number;
  /** Whether `slice` should keep an answer asked for at `ticket`, recording it if so. */
  accepts: (slice: string, ticket: number) => boolean;
}

/**
 * Answers can land out of order: with several employees a refresh asked for
 * earlier may return after one asked for later. Each request takes a ticket
 * when it starts, and a slice only accepts an answer at least as new as the
 * last one it took.
 */
export const latestWins = (): Order => {
  let issued = 0;
  const taken = new Map<string, number>();
  return {
    accepts: (slice, ticket) => {
      if ((taken.get(slice) ?? 0) > ticket) {
        return false;
      }
      taken.set(slice, ticket);
      return true;
    },
    ticket: () => {
      issued += 1;
      return issued;
    },
  };
};

/** Run at most one at a time, and once more if asked again meanwhile: a burst of run ends is two refreshes, not ten. */
export class Coalesced {
  private inFlight: Promise<void> | null = null;
  private again = false;
  private readonly run: () => Promise<void>;

  constructor(run: () => Promise<void>) {
    this.run = run;
  }

  /** Resolves once a run that started after this call has finished. */
  call(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = this.drain();
    return this.inFlight;
  }

  private async drain(): Promise<void> {
    do {
      this.again = false;
      await this.run();
    } while (this.again);
    this.inFlight = null;
  }
}
