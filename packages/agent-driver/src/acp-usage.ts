import type { SessionUpdate, Usage } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { zeroUsage } from "./events";
import type { AgentUsage } from "./events";
import { rateLimitResetIn } from "./rate-limit";

// Claude's cost extension reports this process's running total, including on resume.
const RunCost = z.object({ cost: z.object({ amount: z.number() }) });

/**
 * What one turn spent, from its session's updates and its prompt's response, and when the
 * provider said its rate limit lifts. `perRequest` is the adapter's `usagePerRequest`.
 */
export const usageMeter = (perRequest: boolean) => {
  let total = zeroUsage();
  // a resume may replay what the session spent before, so only the prompt's updates count
  let prompted = false;
  // per request, their sum; for any other agent `used` is its context size, so the largest
  let reportedTokens = 0;
  let lastRequestTokens: number | undefined;
  // when the provider said its rate limit lifts, while it refuses requests (claude's usage updates)
  let rateLimitReset: number | null = null;

  return {
    onResponse: (usage: Usage | null | undefined): void => {
      if (!usage) {
        return;
      }
      // Updates carry only each request's total, so the whole turn takes the last
      // request's split. For any other agent `used` is its context size, not a request.
      const scale =
        perRequest && usage.totalTokens > 0 ? Math.max(1, reportedTokens / usage.totalTokens) : 1;
      const scaled = (tokens: number): number => Math.round(tokens * scale);
      total = {
        cachedTokens: scaled(usage.cachedReadTokens ?? 0),
        costUsd: total.costUsd,
        inputTokens: scaled((usage.inputTokens ?? 0) + (usage.cachedWriteTokens ?? 0)),
        outputTokens: scaled(usage.outputTokens ?? 0),
      };
    },
    onUpdate: (update: SessionUpdate): void => {
      if (update.sessionUpdate === "usage_update") {
        const reset = rateLimitResetIn(update._meta);
        if (reset !== undefined) {
          rateLimitReset = reset;
        }
        if (prompted) {
          if (!perRequest) {
            reportedTokens = Math.max(reportedTokens, update.used);
          } else if (update.used !== lastRequestTokens) {
            // codex re-sends a request's count unchanged; a repeat is not another request
            reportedTokens += update.used;
            lastRequestTokens = update.used;
          }
          // Until the agent's answer accounts for the turn, a turn cut off before it still bills
          // what was reported: as uncached input, since an update carries no split.
          total = { ...total, inputTokens: reportedTokens };
        }
      }
      const cost = RunCost.safeParse(update);
      if (cost.success && cost.data.cost.amount > total.costUsd) {
        total = { ...total, costUsd: cost.data.cost.amount };
      }
    },
    rateLimitReset: (): number | null => rateLimitReset,
    startPrompt: (): void => {
      prompted = true;
    },
    total: (): AgentUsage => total,
  };
};
