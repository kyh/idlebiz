import type { SessionUpdate, Usage } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { zeroUsage } from "./events";
import { rateLimitResetIn } from "./rate-limit";

const RunCost = z.object({ cost: z.object({ amount: z.number() }) });

/**
 * What one turn spent, from its session's updates and its prompt's response, and when the
 * provider said its rate limit lifts. `perRequest` is the adapter's `usagePerRequest`.
 */
export const usageMeter = (perRequest: boolean) => {
  let total = zeroUsage();
  let prompted = false;
  let reportedTokens = 0;
  let lastRequestTokens: number | undefined;
  let rateLimitReset: number | null = null;

  return {
    onResponse: (usage: Usage | null | undefined) => {
      if (!usage) {
        return;
      }

      const scale =
        perRequest && usage.totalTokens > 0 ? Math.max(1, reportedTokens / usage.totalTokens) : 1;

      const scaled = (tokens: number) => Math.round(tokens * scale);
      total = {
        cachedTokens: scaled(usage.cachedReadTokens ?? 0),
        costUsd: total.costUsd,
        inputTokens: scaled((usage.inputTokens ?? 0) + (usage.cachedWriteTokens ?? 0)),
        outputTokens: scaled(usage.outputTokens ?? 0),
      };
    },
    onUpdate: (update: SessionUpdate) => {
      if (update.sessionUpdate === "usage_update") {
        const reset = rateLimitResetIn(update._meta);

        if (reset !== undefined) {
          rateLimitReset = reset;
        }

        if (prompted) {
          if (!perRequest) {
            reportedTokens = Math.max(reportedTokens, update.used);
          } else if (update.used !== lastRequestTokens) {
            reportedTokens += update.used;
            lastRequestTokens = update.used;
          }

          total = { ...total, inputTokens: reportedTokens };
        }
      }

      const cost = RunCost.safeParse(update);

      if (cost.success && cost.data.cost.amount > total.costUsd) {
        total = { ...total, costUsd: cost.data.cost.amount };
      }
    },
    rateLimitReset: () => rateLimitReset,
    startPrompt: () => {
      prompted = true;
    },
    total: () => total,
  };
};
