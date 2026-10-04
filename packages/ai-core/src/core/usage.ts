/** Token usage and cost accounting across provider calls. */

import type { AiProvider, ChatChunk, ChatRequest, ChatResult } from '../providers/types.js';

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

/**
 * Adds or replaces prices (USD per million tokens), e.g. for OpenAI or Gemini
 * models, which ship without prices: `registerModelPrices({ 'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 } })`.
 * Applies process-wide; a {@link UsageTracker} recomputes costs with the current prices.
 */
export function registerModelPrices(prices: Record<string, ModelPrice>): void {
  for (const [model, price] of Object.entries(prices)) {
    if (!(price.input >= 0 && price.output >= 0) || (price.cacheRead ?? 0) < 0 || (price.cacheWrite ?? 0) < 0) {
      throw new Error(`Invalid price for ${model}: ${JSON.stringify(price)}`);
    }
    MODEL_PRICES[model] = { ...price };
  }
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

/** Token counts and calls of one model in one period, as stored. */
export interface UsageCounts extends TokenUsage {
  calls: number;
}

/** What {@link UsageTracker.toJSON} returns and {@link UsageTracker.fromJSON} reads. */
export interface UsageSnapshot {
  version: 1;
  /** Since the tracker was created (or last reset), per model. */
  models: Record<string, UsageCounts>;
  /** Per local day (`YYYY-MM-DD`), per model. */
  days: Record<string, Record<string, UsageCounts>>;
  /** Per local month (`YYYY-MM`), per model. */
  months: Record<string, Record<string, UsageCounts>>;
}

/** Optional spending limits; a request fails fast once one is reached. */
export interface UsageBudget {
  /** Input + output tokens per local day. */
  dailyTokens?: number;
  /** Input + output tokens per local month. */
  monthlyTokens?: number;
  /** USD per local day. Calls on models without a known price count as 0. */
  dailyUsd?: number;
  /** USD per local month. Calls on models without a known price count as 0. */
  monthlyUsd?: number;
}

/** Where a {@link UsageTracker} keeps its {@link UsageSnapshot} between restarts. */
export interface UsageStore {
  load(): Promise<UsageSnapshot | undefined>;
  save(snapshot: UsageSnapshot): Promise<void>;
}

export interface UsageTrackerOptions {
  budget?: UsageBudget;
  /** Saves the snapshot after every `add()` (writes are coalesced; await `flush()` before exiting). */
  store?: UsageStore;
  /** Called when saving to the store fails (default: ignored, the next add retries). */
  onSaveError?: (error: unknown) => void;
  /** Days kept in `byDay()` / the snapshot (default 62). */
  retainDays?: number;
  /** Months kept in `byMonth()` / the snapshot (default 24). */
  retainMonths?: number;
  /** Clock (tests). */
  now?: () => Date;
}

/** Thrown by {@link UsageTracker.checkBudget} (and so by a {@link trackUsage} provider) once a budget is used up. */
export class BudgetExceededError extends Error {
  constructor(
    readonly period: 'day' | 'month',
    readonly unit: 'tokens' | 'usd',
    readonly used: number,
    readonly limit: number,
  ) {
    const amount = (n: number) => (unit === 'usd' ? `$${n.toFixed(2)}` : `${Math.round(n).toLocaleString('en-US')} tokens`);
    const when = period === 'day' ? 'today' : 'this month';
    const resets = period === 'day' ? 'at midnight' : 'on the 1st of next month';
    super(`The ${period === 'day' ? 'daily' : 'monthly'} AI budget is used up: ${amount(used)} of ${amount(limit)} ${when}. It resets ${resets}.`);
    this.name = 'BudgetExceededError';
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local `YYYY-MM-DD`. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local `YYYY-MM`. */
export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function countsOf(raw: unknown): UsageCounts {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: UsageCounts = { inputTokens: count(r.inputTokens), outputTokens: count(r.outputTokens), calls: count(r.calls) };
  if (r.cacheReadTokens !== undefined) {
    out.cacheReadTokens = count(r.cacheReadTokens);
  }
  if (r.cacheWriteTokens !== undefined) {
    out.cacheWriteTokens = count(r.cacheWriteTokens);
  }
  return out;
}

function modelsOf(raw: unknown): Map<string, UsageCounts> {
  const entries = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? Object.entries(raw) : [];
  return new Map(entries.map(([model, c]) => [model, countsOf(c)]));
}

function periodsOf(raw: unknown): Map<string, Map<string, UsageCounts>> {
  const entries = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? Object.entries(raw) : [];
  return new Map(entries.map(([key, models]) => [key, modelsOf(models)]));
}

function bump(models: Map<string, UsageCounts>, model: string, usage: TokenUsage): void {
  const prev = models.get(model) ?? { inputTokens: 0, outputTokens: 0, calls: 0 };
  const { calls, ...tokens } = prev;
  models.set(model, { ...addUsage(tokens, usage), calls: calls + 1 });
}

function summarize(model: string, c: UsageCounts): UsageSummary {
  return { ...c, costUsd: costOf(model, c) };
}

function sum(models: Map<string, UsageCounts> | undefined): UsageSummary {
  let total: UsageSummary = { inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0 };
  for (const [model, c] of models ?? []) {
    const m = summarize(model, c);
    total = {
      ...addUsage(total, m),
      calls: total.calls + m.calls,
      costUsd: total.costUsd === null || m.costUsd === null ? null : total.costUsd + m.costUsd,
    };
  }
  return total;
}

/** USD of the priced calls only (unpriced models count as 0), for budgets. */
function knownCost(models: Map<string, UsageCounts> | undefined): number {
  let usd = 0;
  for (const [model, c] of models ?? []) {
    usd += costOf(model, c) ?? 0;
  }
  return usd;
}

function toObject(models: Map<string, UsageCounts>): Record<string, UsageCounts> {
  return Object.fromEntries([...models].map(([k, v]) => [k, { ...v }]));
}

function prune(periods: Map<string, unknown>, keep: number): void {
  const keys = [...periods.keys()].sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - keep))) {
    periods.delete(key);
  }
}

/**
 * Accumulates usage per model, per local day and per local month; `total`
 * sums everything. Costs are computed from the token counts with the current
 * prices, so prices registered later apply to earlier calls too. Optionally
 * enforces a {@link UsageBudget} and persists to a {@link UsageStore}.
 */
export class UsageTracker {
  private models = new Map<string, UsageCounts>();
  private days = new Map<string, Map<string, UsageCounts>>();
  private months = new Map<string, Map<string, UsageCounts>>();
  private budgetLimits: UsageBudget;
  private readonly options: UsageTrackerOptions;
  private saving: Promise<void> | undefined;
  private dirty = false;

  constructor(options: UsageTrackerOptions = {}) {
    this.options = options;
    this.budgetLimits = { ...options.budget };
  }

  /** A tracker restored from a snapshot (unknown or malformed fields are ignored). */
  static fromJSON(snapshot: unknown, options: UsageTrackerOptions = {}): UsageTracker {
    const tracker = new UsageTracker(options);
    const s = (typeof snapshot === 'object' && snapshot !== null ? snapshot : {}) as Partial<Record<keyof UsageSnapshot, unknown>>;
    tracker.models = modelsOf(s.models);
    tracker.days = periodsOf(s.days);
    tracker.months = periodsOf(s.months);
    return tracker;
  }

  /** A tracker restored from `store` (empty when it holds nothing yet) that saves back to it. */
  static async load(store: UsageStore, options: Omit<UsageTrackerOptions, 'store'> = {}): Promise<UsageTracker> {
    return UsageTracker.fromJSON(await store.load(), { ...options, store });
  }

  toJSON(): UsageSnapshot {
    const periods = (p: Map<string, Map<string, UsageCounts>>) => Object.fromEntries([...p].map(([k, m]) => [k, toObject(m)]));
    return { version: 1, models: toObject(this.models), days: periods(this.days), months: periods(this.months) };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  add(model: string, usage: TokenUsage): void {
    const now = this.now();
    const day = dayKey(now);
    const month = monthKey(now);
    bump(this.models, model, usage);
    if (!this.days.has(day)) {
      this.days.set(day, new Map());
    }
    bump(this.days.get(day)!, model, usage);
    if (!this.months.has(month)) {
      this.months.set(month, new Map());
    }
    bump(this.months.get(month)!, model, usage);
    prune(this.days, this.options.retainDays ?? 62);
    prune(this.months, this.options.retainMonths ?? 24);
    this.persist();
  }

  byModel(): Record<string, UsageSummary> {
    return Object.fromEntries([...this.models].map(([model, c]) => [model, summarize(model, c)]));
  }

  get total(): UsageSummary {
    return sum(this.models);
  }

  /** Today's totals (local time). */
  today(): UsageSummary {
    return sum(this.days.get(dayKey(this.now())));
  }

  /** This month's totals (local time). */
  thisMonth(): UsageSummary {
    return sum(this.months.get(monthKey(this.now())));
  }

  /** Totals per kept day, `YYYY-MM-DD` → summary. */
  byDay(): Record<string, UsageSummary> {
    return Object.fromEntries([...this.days].map(([key, models]) => [key, sum(models)]));
  }

  /** Totals per kept month, `YYYY-MM` → summary. */
  byMonth(): Record<string, UsageSummary> {
    return Object.fromEntries([...this.months].map(([key, models]) => [key, sum(models)]));
  }

  get budget(): UsageBudget {
    return { ...this.budgetLimits };
  }

  set budget(budget: UsageBudget) {
    this.budgetLimits = { ...budget };
  }

  /** The first budget that is used up, or undefined when every limit still has room. */
  exceededBudget(): BudgetExceededError | undefined {
    const b = this.budgetLimits;
    const now = this.now();
    const day = this.days.get(dayKey(now));
    const month = this.months.get(monthKey(now));
    const tokens = (m: Map<string, UsageCounts> | undefined) => {
      const t = sum(m);
      return t.inputTokens + t.outputTokens;
    };
    const checks: Array<[BudgetExceededError['period'], BudgetExceededError['unit'], number | undefined, () => number]> = [
      ['day', 'tokens', b.dailyTokens, () => tokens(day)],
      ['day', 'usd', b.dailyUsd, () => knownCost(day)],
      ['month', 'tokens', b.monthlyTokens, () => tokens(month)],
      ['month', 'usd', b.monthlyUsd, () => knownCost(month)],
    ];
    for (const [period, unit, limit, used] of checks) {
      if (limit !== undefined) {
        const value = used();
        if (value >= limit) {
          return new BudgetExceededError(period, unit, value, limit);
        }
      }
    }
    return undefined;
  }

  /** Throws a {@link BudgetExceededError} once a budget is used up. Call before a request. */
  checkBudget(): void {
    const exceeded = this.exceededBudget();
    if (exceeded) {
      throw exceeded;
    }
  }

  /** Resolves once every pending save to the store has finished. */
  async flush(): Promise<void> {
    while (this.saving) {
      await this.saving;
    }
  }

  private persist(): void {
    const store = this.options.store;
    if (!store) {
      return;
    }
    if (this.saving) {
      this.dirty = true;
      return;
    }
    this.saving = (async () => {
      do {
        this.dirty = false;
        try {
          await store.save(this.toJSON());
        } catch (error) {
          this.options.onSaveError?.(error);
        }
      } while (this.dirty);
    })().finally(() => {
      this.saving = undefined;
    });
  }

  /** Forgets everything (and saves the empty state when there is a store). */
  reset(): void {
    this.models.clear();
    this.days.clear();
    this.months.clear();
    this.persist();
  }
}

/**
 * Wraps `provider` so every call checks `tracker`'s budget first (rejecting
 * with a {@link BudgetExceededError} without calling the provider) and records
 * the usage of every completed call.
 */
export function trackUsage<P extends AiProvider>(provider: P, tracker: UsageTracker): P {
  const chat = async (request: ChatRequest): Promise<ChatResult> => {
    tracker.checkBudget();
    const result = await provider.chat(request);
    tracker.add(result.model, result.usage);
    return result;
  };
  async function* stream(request: ChatRequest): AsyncGenerator<ChatChunk> {
    tracker.checkBudget();
    for await (const chunk of provider.stream(request)) {
      if (chunk.type === 'done') {
        tracker.add(chunk.result.model, chunk.usage);
      }
      yield chunk;
    }
  }
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === 'chat') {
        return chat;
      }
      if (prop === 'stream') {
        return stream;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
