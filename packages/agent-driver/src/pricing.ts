import type { AgentUsage } from "./events.ts";

// Estimated USD per million tokens when the CLI reports no dollar cost.

interface Rates {
  input: number;
  cachedInput: number;
  output: number;
}

/** First matching prefix wins; put more specific models before their families. */
const RATE_TABLE: readonly (readonly [prefix: string, rates: Rates])[] = [
  ["gpt-5", { input: 1.25, cachedInput: 0.125, output: 10 }],
  ["claude-fable", { input: 10, cachedInput: 1, output: 50 }],
  ["claude-opus", { input: 5, cachedInput: 0.5, output: 25 }],
  ["claude-sonnet", { input: 3, cachedInput: 0.3, output: 15 }],
  ["claude-haiku", { input: 1, cachedInput: 0.1, output: 5 }],
];

const DEFAULT_RATES: Rates = { input: 2, cachedInput: 0.2, output: 12 };

function ratesFor(model: string): Rates {
  for (const [prefix, rates] of RATE_TABLE) {
    if (model.startsWith(prefix)) return rates;
  }
  return DEFAULT_RATES;
}

/** Approximate USD for a run whose CLI didn't report a dollar cost. */
export function priceUsage(model: string, usage: AgentUsage): number {
  const r = ratesFor(model);
  return (
    (usage.inputTokens * r.input +
      usage.cachedTokens * r.cachedInput +
      usage.outputTokens * r.output) /
    1_000_000
  );
}
