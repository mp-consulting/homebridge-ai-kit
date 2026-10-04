import { describe, expect, it } from 'vitest';
import { UsageTracker, addUsage, costOf } from '../../src/core/usage.js';

describe('usage', () => {
  it('prices Claude models, including dated snapshots', () => {
    expect(costOf('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(12);
    expect(costOf('claude-haiku-4-5-20251001', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(1);
    expect(costOf('claude-opus-5-5', { inputTokens: 0, outputTokens: 1_000_000 })).toBe(20);
    expect(costOf('gpt-5', { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });

  it('adds usage', () => {
    expect(addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 })).toEqual({ inputTokens: 4, outputTokens: 6 });
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
