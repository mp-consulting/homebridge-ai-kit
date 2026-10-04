import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JsonFileUsageStore } from '../../src/core/usage-store.js';
import { BudgetExceededError, UsageTracker, dayKey, monthKey, trackUsage } from '../../src/core/usage.js';
import type { UsageSnapshot, UsageStore } from '../../src/core/usage.js';
import { fakeProvider } from '../providers/helpers.js';

function clock(iso: string) {
  let now = new Date(iso);
  return { now: () => now, set: (next: string) => (now = new Date(next)) };
}

const M = 'claude-sonnet-5-5'; // $2 in, $10 out per MTok

describe('UsageTracker periods', () => {
  it('keys days and months in local time', () => {
    const d = new Date(2026, 0, 5, 23, 59);
    expect(dayKey(d)).toBe('2026-01-05');
    expect(monthKey(d)).toBe('2026-01');
  });

  it('tracks today, this month, per day and per month', () => {
    const c = clock('2026-10-04T10:00:00');
    const tracker = new UsageTracker({ now: c.now });
    tracker.add(M, { inputTokens: 1_000_000, outputTokens: 0 });
    c.set('2026-10-05T10:00:00');
    tracker.add(M, { inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0 });
    tracker.add('llama3.1', { inputTokens: 10, outputTokens: 0 });
    expect(tracker.today()).toEqual({ inputTokens: 10, outputTokens: 100_000, cacheReadTokens: 0, calls: 2, costUsd: null });
    expect(tracker.thisMonth()).toMatchObject({ inputTokens: 1_000_010, calls: 3 });
    expect(Object.keys(tracker.byDay())).toEqual(['2026-10-04', '2026-10-05']);
    expect(tracker.byDay()['2026-10-04']).toEqual({ inputTokens: 1_000_000, outputTokens: 0, calls: 1, costUsd: 2 });
    expect(tracker.byMonth()['2026-10']?.calls).toBe(3);
    c.set('2026-11-01T00:00:00');
    expect(tracker.today().calls).toBe(0);
    expect(tracker.thisMonth()).toEqual({ inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0 });
    expect(new UsageTracker().today().calls).toBe(0);
  });

  it('keeps only the most recent days and months', () => {
    const c = clock('2026-01-01T12:00:00');
    const tracker = new UsageTracker({ now: c.now, retainDays: 2, retainMonths: 1 });
    for (const day of ['2026-01-01', '2026-01-02', '2026-02-03']) {
      c.set(`${day}T12:00:00`);
      tracker.add(M, { inputTokens: 1, outputTokens: 1 });
    }
    expect(Object.keys(tracker.byDay())).toEqual(['2026-01-02', '2026-02-03']);
    expect(Object.keys(tracker.byMonth())).toEqual(['2026-02']);
    expect(tracker.total.calls).toBe(3);
  });
});

describe('UsageTracker serialization', () => {
  it('round-trips through toJSON / fromJSON', () => {
    const c = clock('2026-10-04T10:00:00');
    const tracker = new UsageTracker({ now: c.now });
    tracker.add(M, { inputTokens: 5, outputTokens: 6, cacheReadTokens: 2, cacheWriteTokens: 1 });
    const json = JSON.parse(JSON.stringify(tracker)) as UsageSnapshot;
    expect(json).toEqual({
      version: 1,
      models: { [M]: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 2, cacheWriteTokens: 1, calls: 1 } },
      days: { '2026-10-04': { [M]: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 2, cacheWriteTokens: 1, calls: 1 } } },
      months: { '2026-10': { [M]: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 2, cacheWriteTokens: 1, calls: 1 } } },
    });
    const restored = UsageTracker.fromJSON(json, { now: c.now });
    expect(restored.toJSON()).toEqual(json);
    expect(restored.today().calls).toBe(1);
    restored.add(M, { inputTokens: 1, outputTokens: 1 });
    expect(restored.total.calls).toBe(2);
  });

  it('ignores malformed snapshots', () => {
    expect(UsageTracker.fromJSON(null).total.calls).toBe(0);
    expect(UsageTracker.fromJSON({ models: [], days: 'x' }).total.calls).toBe(0);
    const t = UsageTracker.fromJSON({ models: { a: { inputTokens: -5, outputTokens: 'x', calls: 2 }, b: null } });
    expect(t.byModel().a).toEqual({ inputTokens: 0, outputTokens: 0, calls: 2, costUsd: null });
    expect(t.byModel().b?.calls).toBe(0);
  });
});

describe('UsageTracker budgets', () => {
  it('fails fast once a daily token budget is used up', () => {
    const c = clock('2026-10-04T10:00:00');
    const tracker = new UsageTracker({ now: c.now, budget: { dailyTokens: 1000 } });
    expect(tracker.exceededBudget()).toBeUndefined();
    tracker.add(M, { inputTokens: 600, outputTokens: 300 });
    expect(() => tracker.checkBudget()).not.toThrow();
    tracker.add(M, { inputTokens: 100, outputTokens: 0 });
    const error = (() => {
      try {
        tracker.checkBudget();
      } catch (e) {
        return e;
      }
    })() as BudgetExceededError;
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error).toMatchObject({ period: 'day', unit: 'tokens', used: 1000, limit: 1000 });
    expect(error.message).toBe('The daily AI budget is used up: 1,000 tokens of 1,000 tokens today. It resets at midnight.');
    c.set('2026-10-05T00:00:01');
    expect(() => tracker.checkBudget()).not.toThrow();
  });

  it('enforces USD and monthly budgets, counting unpriced models as 0', () => {
    const c = clock('2026-10-04T10:00:00');
    const tracker = new UsageTracker({ now: c.now, budget: { dailyUsd: 5 } });
    tracker.add('llama3.1', { inputTokens: 10_000_000, outputTokens: 0 });
    expect(tracker.exceededBudget()).toBeUndefined();
    tracker.add(M, { inputTokens: 0, outputTokens: 500_000 });
    expect(tracker.exceededBudget()).toMatchObject({ period: 'day', unit: 'usd', used: 5, limit: 5 });
    expect(tracker.exceededBudget()?.message).toBe('The daily AI budget is used up: $5.00 of $5.00 today. It resets at midnight.');

    tracker.budget = { monthlyUsd: 100, monthlyTokens: 10_000_000 };
    expect(tracker.budget).toEqual({ monthlyUsd: 100, monthlyTokens: 10_000_000 });
    const month = tracker.exceededBudget();
    expect(month).toMatchObject({ period: 'month', unit: 'tokens' });
    expect(month?.message).toContain('this month. It resets on the 1st of next month.');
    tracker.budget = { monthlyUsd: 4 };
    expect(tracker.exceededBudget()).toMatchObject({ period: 'month', unit: 'usd' });
  });
});

describe('trackUsage', () => {
  it('records chat and stream usage and refuses calls over budget', async () => {
    const { provider } = fakeProvider([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
    const tracker = new UsageTracker({ budget: { dailyTokens: 30 } });
    const tracked = trackUsage(provider, tracker);
    expect(tracked.name).toBe('anthropic');
    expect(tracked.capabilities.tools).toBe(true);
    await tracked.chat({ messages: [] });
    const chunks = [];
    for await (const chunk of tracked.stream({ messages: [] })) {
      chunks.push(chunk);
    }
    expect(chunks.at(-1)).toMatchObject({ type: 'done' });
    expect(tracker.byModel()['fake-model']).toMatchObject({ inputTokens: 20, outputTokens: 10, calls: 2 });
    await expect(tracked.chat({ messages: [] })).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(async () => {
      for await (const chunk of tracked.stream({ messages: [] })) {
        void chunk;
      }
    }).rejects.toThrow('daily AI budget');
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(provider.stream).toHaveBeenCalledTimes(1);
  });
});

describe('persistence', () => {
  it('saves after each add, coalescing writes, and loads back', async () => {
    let saved: UsageSnapshot | undefined;
    let release: () => void = () => {};
    const saves: UsageSnapshot[] = [];
    const store: UsageStore = {
      load: vi.fn(async () => saved),
      save: vi.fn(async (s: UsageSnapshot) => {
        saves.push(s);
        await new Promise<void>((r) => (release = r));
        saved = s;
      }),
    };
    const tracker = await UsageTracker.load(store);
    tracker.add(M, { inputTokens: 1, outputTokens: 1 });
    tracker.add(M, { inputTokens: 1, outputTokens: 1 });
    tracker.add(M, { inputTokens: 1, outputTokens: 1 });
    const flushed = tracker.flush();
    release();
    await vi.waitFor(() => expect(saves).toHaveLength(2));
    release();
    await flushed;
    expect(saves[1]?.models[M]?.calls).toBe(3);
    const reloaded = await UsageTracker.load(store);
    expect(reloaded.total.calls).toBe(3);
    await new UsageTracker().flush();
  });

  it('reports save errors and keeps going', async () => {
    const onSaveError = vi.fn();
    const store: UsageStore = { load: async () => undefined, save: vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined) };
    const tracker = new UsageTracker({ store, onSaveError });
    tracker.add(M, { inputTokens: 1, outputTokens: 1 });
    await tracker.flush();
    expect(onSaveError).toHaveBeenCalledWith(new Error('disk full'));
    tracker.reset();
    await tracker.flush();
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(tracker.total.calls).toBe(0);
    const quiet = new UsageTracker({ store: { load: async () => undefined, save: async () => Promise.reject(new Error('x')) } });
    quiet.add(M, { inputTokens: 1, outputTokens: 1 });
    await quiet.flush();
  });

  it('JsonFileUsageStore writes and reads a JSON file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiusage-'));
    const store = new JsonFileUsageStore(join(dir, 'nested', 'usage.json'));
    expect(await store.load()).toBeUndefined();
    const tracker = await UsageTracker.load(store);
    tracker.add(M, { inputTokens: 3, outputTokens: 4 });
    await tracker.flush();
    expect(JSON.parse(await readFile(store.path, 'utf8')).models[M].calls).toBe(1);
    expect((await UsageTracker.load(store)).total.inputTokens).toBe(3);

    await writeFile(store.path, '{oops');
    await expect(store.load()).rejects.toThrow(/Cannot parse the AI usage file/);
    await expect(new JsonFileUsageStore(dir).load()).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
