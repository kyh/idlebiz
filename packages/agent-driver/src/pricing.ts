import type { AgentUsage } from "./events.ts";

// Codex reports token usage but never dollar cost, and subscription-authed
// claude runs can report $0 — these $/MTok rates turn tokens into the spend
// meter's USD as a best-effort approximation. Update alongside provider
// price changes; exact billing lives with the provider, not here.

interface Rates {
  input: number;
  cachedInput: number;
  output: number;
}

/** Longest-prefix match wins; the bare fallback covers unknown models. */
const RATE_TABLE: readonly (readonly [prefix: string, rates: Rates])[] = [
  ["gpt-5.5-codex", { input: 1.25, cachedInput: 0.125, output: 10 }],
  ["gpt-5.5", { input: 1.25, cachedInput: 0.125, output: 10 }],
  ["gpt-5", { input: 1.25, cachedInput: 0.125, output: 10 }],
  ["claude-fable", { input: 10, cachedInput: 1, output: 50 }],
  ["claude-opus", { input: 5, cachedInput: 0.5, output: 25 }],
  ["claude-sonnet", { input: 3, cachedInput: 0.3, output: 15 }],
  ["claude-haiku", { input: 1, cachedInput: 0.1, output: 5 }],
];

const DEFAULT_RATES: Rates = { input: 2, cachedInput: 0.2, output: 12 };

function ratesFor(model: string | undefined): Rates {
  if (model) {
    for (const [prefix, rates] of RATE_TABLE) {
      if (model.startsWith(prefix)) return rates;
    }
  }
  return DEFAULT_RATES;
}

/** Approximate USD for a run whose CLI didn't report a dollar cost. */
export function priceUsage(model: string | undefined, usage: AgentUsage): number {
  const r = ratesFor(model);
  return (
    (usage.inputTokens * r.input +
      usage.cachedTokens * r.cachedInput +
      usage.outputTokens * r.output) /
    1_000_000
  );
}
