/** Token usage and cost accounting across provider calls. */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** USD per million tokens. Claude first-party API list prices. */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export const ZERO_USAGE: TokenUsage = Object.freeze({ inputTokens: 0, outputTokens: 0 });

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

/** Cost in USD of `usage` on `model`, or null when the model's price is unknown. */
export function costOf(model: string, usage: TokenUsage): number | null {
  // Dated snapshots (claude-haiku-4-5-20251001) cost the same as their alias.
  const price = MODEL_PRICES[model] ?? MODEL_PRICES[model.replace(/-\d{8}$/, '')];
  if (!price) {
    return null;
  }
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
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
    const next = addUsage(prev, usage);
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
