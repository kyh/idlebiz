import { z } from "zod";

/** How many ship lines the digest keeps and its window lists. */
export const DIGEST_SHIPS_SHOWN = 5;

/** What happened while the founder was away: folded from each event as it
 *  is published, so an absence of any length is counted in full. */
export const DigestSchema = z.object({
  /** Tasks that gave up while they were away. */
  dead: z.number(),
  hired: z.array(z.string()),
  released: z.array(z.string()),
  runs: z.number(),
  /** How many shipped; `ships` holds only the latest few of them. */
  shipped: z.number(),
  /** The latest ship summaries, oldest first: at most DIGEST_SHIPS_SHOWN. */
  ships: z.array(z.string()),
  since: z.number(),
  spentUsd: z.number(),
});

export type Digest = z.infer<typeof DigestSchema>;
