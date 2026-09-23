// Two guards for a renderer that mirrors main's state by asking for it again.

export interface Order<K extends string> {
  /** Taken when a request starts. */
  ticket: () => number;
  /** Whether `slice` should keep an answer asked for at `ticket`, recording it if so. */
  accepts: (slice: K, ticket: number) => boolean;
  /** `slice` was just changed in place, so it is newer than any answer still in flight. */
  patched: (slice: K) => void;
}

/**
 * Answers can land out of order: with several employees a refresh asked for
 * earlier may return after one asked for later. Each request takes a ticket
 * when it starts, and a slice only accepts an answer at least as new as the
 * last one it took, or than the last patch an event made to it.
 */
export const latestWins = <K extends string>(): Order<K> => {
  let issued = 0;
  const taken = new Map<K, number>();
  const ticket = (): number => {
    issued += 1;
    return issued;
  };
  return {
    accepts: (slice, asked) => {
      if ((taken.get(slice) ?? 0) > asked) {
        return false;
      }
      taken.set(slice, asked);
      return true;
    },
    patched: (slice) => {
      taken.set(slice, ticket());
    },
    ticket,
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
    try {
      do {
        this.again = false;
        await this.run();
      } while (this.again);
    } finally {
      this.inFlight = null;
    }
  }
}
