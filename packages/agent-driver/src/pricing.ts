import type { AgentUsage } from "./events.ts";

// Estimated USD per million tokens when the CLI reports no dollar cost.

interface Rates {
  input: number;
  cachedInput: number;
  output: number;
}

/** First matching prefix wins; put more specific models before their families. */
const RATE_TABLE: readonly (readonly [prefix: string, rates: Rates])[] = [
  ["gpt-5", { cachedInput: 0.125, input: 1.25, output: 10 }],
  ["claude-fable", { cachedInput: 1, input: 10, output: 50 }],
  ["claude-opus", { cachedInput: 0.5, input: 5, output: 25 }],
  ["claude-sonnet", { cachedInput: 0.3, input: 3, output: 15 }],
  ["claude-haiku", { cachedInput: 0.1, input: 1, output: 5 }],
];

const DEFAULT_RATES: Rates = { cachedInput: 0.2, input: 2, output: 12 };

const ratesFor = (model: string): Rates => {
  for (const [prefix, rates] of RATE_TABLE) {
    if (model.startsWith(prefix)) {
      return rates;
    }
  }
  return DEFAULT_RATES;
};

/** Approximate USD for a run whose CLI didn't report a dollar cost. */
export const priceUsage = (model: string, usage: AgentUsage): number => {
  const r = ratesFor(model);
  return (
    (usage.inputTokens * r.input +
      usage.cachedTokens * r.cachedInput +
      usage.outputTokens * r.output) /
    1_000_000
  );
};
