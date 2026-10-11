import type { BlockedAsk } from "@repo/domain/domain";

/** The first thing a run asks the founder is the one they answer; later asks in the same run are dropped. */
export interface AskBox {
  /** False when the run had already asked, and this ask was dropped. */
  raise: (ask: BlockedAsk) => boolean;
  current: () => BlockedAsk | null;
}

export const askBox = (onFirst: (ask: BlockedAsk) => void): AskBox => {
  let first: BlockedAsk | null = null;
  return {
    current: () => first,
    raise: (ask) => {
      if (first !== null) {
        return false;
      }
      first = ask;
      onFirst(ask);
      return true;
    },
  };
};
