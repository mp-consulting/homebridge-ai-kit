import { describe, expect, it } from 'vitest';
import { MODEL_PRICES, UsageTracker, addUsage, costOf, priceOf, registerModelPrices } from '../../src/core/usage.js';

describe('usage', () => {
  it('prices Claude models, including dated snapshots', () => {
    expect(costOf('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(12);
    expect(costOf('claude-haiku-4-5-20251001', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(1);
    expect(costOf('claude-opus-5-5', { inputTokens: 0, outputTokens: 1_000_000 })).toBe(20);
    expect(costOf('gpt-5', { inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(priceOf('models/claude-haiku-4-5')).toBe(MODEL_PRICES['claude-haiku-4-5']);
  });

  it('prices cache reads and writes at the cache rates', () => {
    // Sonnet 5.5: $2 input, $0.20 cache read, $2.50 cache write (5-minute TTL), $10 output.
    const usage = { inputTokens: 3_000_000, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    expect(costOf('claude-sonnet-5-5', usage)).toBeCloseTo(2 + 0.2 + 2.5);
    // Opus 5.5 reads at 0.05x, Fable 5.1 at 0.025x.
    expect(costOf('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.2);
    expect(costOf('claude-fable-5-1', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.25);
    expect(costOf('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000_000 })).toBeCloseTo(1.25);
    // Inconsistent counts never go negative.
    expect(costOf('claude-haiku-4-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 10 })).toBeCloseTo(0.000001);
  });

  it('every Claude price has cache rates', () => {
    for (const [model, price] of Object.entries(MODEL_PRICES)) {
      expect(price.cacheWrite, model).toBeCloseTo(price.input * 1.25);
      expect(price.cacheRead, model).toBeLessThanOrEqual(price.input * 0.1);
    }
  });

  it('takes registered prices for other providers, with cached input', () => {
    registerModelPrices({ 'test-gpt': { input: 1, output: 8, cacheRead: 0.1 }, 'test-gemini': { input: 0.5, output: 3 } });
    try {
      expect(costOf('test-gpt', { inputTokens: 2_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 })).toBeCloseTo(1 + 0.1 + 8);
      expect(costOf('test-gpt-2025-08-07', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(1);
      expect(costOf('models/test-gemini', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBe(0.5);
      expect(() => registerModelPrices({ bad: { input: -1, output: 1 } })).toThrow('Invalid price for bad');
      expect(() => registerModelPrices({ bad: { input: 1, output: 1, cacheRead: -1 } })).toThrow('Invalid price');
      expect(() => registerModelPrices({ bad: { input: 1, output: 1, cacheWrite: -1 } })).toThrow('Invalid price');
      expect(() => registerModelPrices({ bad: { input: Number.NaN, output: 1 } })).toThrow('Invalid price');
    } finally {
      delete MODEL_PRICES['test-gpt'];
      delete MODEL_PRICES['test-gemini'];
    }
  });

  it('adds usage', () => {
    expect(addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 })).toStrictEqual({ inputTokens: 4, outputTokens: 6 });
    expect(addUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 1 }, { inputTokens: 3, outputTokens: 4, cacheWriteTokens: 2 })).toStrictEqual({
      inputTokens: 4,
      outputTokens: 6,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
    });
  });

  it('tracks per model and in total', () => {
    const tracker = new UsageTracker();
    expect(tracker.total).toEqual({ inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0 });
    tracker.add('claude-sonnet-5-5', { inputTokens: 500_000, outputTokens: 0 });
    tracker.add('claude-sonnet-5-5', { inputTokens: 500_000, outputTokens: 100_000 });
    expect(tracker.byModel()['claude-sonnet-5-5']).toEqual({ inputTokens: 1_000_000, outputTokens: 100_000, calls: 2, costUsd: 3 });
    expect(tracker.total.costUsd).toBe(3);
    tracker.add('llama3.1', { inputTokens: 10, outputTokens: 10 });
    expect(tracker.total).toEqual({ inputTokens: 1_000_010, outputTokens: 100_010, calls: 3, costUsd: null });
    tracker.reset();
    expect(tracker.total.calls).toBe(0);
  });
});
