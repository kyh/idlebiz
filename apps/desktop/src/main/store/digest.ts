import type { PersistedActivity } from "@/shared/activity";
import { DIGEST_SHIPS_SHOWN } from "@/shared/digest";
import type { Digest } from "@/shared/digest";

/** Nothing has happened yet since the founder looked at `since`. */
export const emptyDigest = (since: number): Digest => ({
  dead: 0,
  hired: [],
  released: [],
  runs: 0,
  shipped: 0,
  ships: [],
  since,
  spentUsd: 0,
});

/** The digest with one more event in it, or null when the event is not one it counts. */
export const foldDigest = (d: Digest, e: PersistedActivity): Digest | null => {
  switch (e.kind) {
    case "ship": {
      return {
        ...d,
        shipped: d.shipped + 1,
        ships: [...d.ships, e.message].slice(-DIGEST_SHIPS_SHOWN),
      };
    }
    case "run.end": {
      return { ...d, runs: d.runs + 1, spentUsd: d.spentUsd + (e.payload.costUsd ?? 0) };
    }
    case "task.dead": {
      return { ...d, dead: d.dead + 1 };
    }
    case "org.hired": {
      return { ...d, hired: [...d.hired, e.payload.name] };
    }
    case "org.released": {
      return { ...d, released: [...d.released, e.payload.name] };
    }
    default: {
      return null;
    }
  }
};
