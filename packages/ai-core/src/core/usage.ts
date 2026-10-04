/** Token usage and cost accounting across provider calls. */

export interface TokenUsage {
  /** Every input token of the call, cached ones included. */
  inputTokens: number;
  outputTokens: number;
  /** Of `inputTokens`, how many were read from the provider's prompt cache. */
  cacheReadTokens?: number;
  /** Of `inputTokens`, how many were written to the prompt cache (Claude bills these at a premium). */
  cacheWriteTokens?: number;
}

/** USD per million tokens. `cacheRead` / `cacheWrite` default to `input` when absent. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Claude first-party API list prices, USD per million tokens. Cache writes are
 * the 5-minute TTL rate (1.25x input, the TTL the Anthropic adapter uses);
 * cache reads are 0.1x input except Claude Fable 5.1 (0.025x) and Claude Opus 5.5 (0.05x).
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export const ZERO_USAGE: TokenUsage = Object.freeze({ inputTokens: 0, outputTokens: 0 });

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum: TokenUsage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
  if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined) {
    sum.cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  }
  if (a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined) {
    sum.cacheWriteTokens = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  }
  return sum;
}

/** The price of `model`: exact id, else without a date suffix (`-20251001`, `-2025-08-07`) or a `models/` prefix. */
export function priceOf(model: string): ModelPrice | undefined {
  const bare = model.replace(/^models\//, '');
  return MODEL_PRICES[bare] ?? MODEL_PRICES[bare.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '')];
}

/** Cost in USD of `usage` on `model`, or null when the model's price is unknown. Cached input is priced at the cache rates. */
export function costOf(model: string, usage: TokenUsage): number | null {
  const price = priceOf(model);
  if (!price) {
    return null;
  }
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - read - write);
  const input = uncached * price.input + read * (price.cacheRead ?? price.input) + write * (price.cacheWrite ?? price.input);
  return (input + usage.outputTokens * price.output) / 1_000_000;
}

export interface UsageSummary extends TokenUsage {
  calls: number;
  /** Null when any call used a model without a known price. */
  costUsd: number | null;
}

/** Accumulates usage per model; `total` sums everything. */
export class UsageTracker {
  private readonly models = new Map<string, UsageSummary>();

  add(model: string, usage: TokenUsage): void {
    const prev = this.models.get(model) ?? { inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0 };
    const { calls, costUsd, ...tokens } = prev; // eslint-disable-line @typescript-eslint/no-unused-vars
    const next = addUsage(tokens, usage);
    this.models.set(model, { ...next, calls: prev.calls + 1, costUsd: costOf(model, next) });
  }

  byModel(): Record<string, UsageSummary> {
    return Object.fromEntries(this.models);
  }

  get total(): UsageSummary {
    let total: UsageSummary = { inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0 };
    for (const m of this.models.values()) {
      total = {
        ...addUsage(total, m),
        calls: total.calls + m.calls,
        costUsd: total.costUsd === null || m.costUsd === null ? null : total.costUsd + m.costUsd,
      };
    }
    return total;
  }

  reset(): void {
    this.models.clear();
  }
}
