import type { AgentUsage } from "./events.ts";

/** Estimated USD per million tokens. */
export interface Rates {
  input: number;
  cachedInput: number;
  output: number;
}

/** Approximate USD for a run whose CLI didn't report a dollar cost. */
export const priceUsage = (rates: Rates, usage: AgentUsage): number =>
  (usage.inputTokens * rates.input +
    usage.cachedTokens * rates.cachedInput +
    usage.outputTokens * rates.output) /
  1_000_000;
