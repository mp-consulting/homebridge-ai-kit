import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmationBroker, withConfirmTimeout } from '../../src/core/confirm.js';
import { ANSI_PATTERN, readLogTail, stripAnsi, tailLines } from '../../src/core/logs.js';
import { SlidingWindowRateLimiter } from '../../src/core/rate-limit.js';
import { PAIRING_KEYS, redactPairing } from '../../src/core/redaction.js';
import { TtlCache } from '../../src/core/ttl-cache.js';

afterEach(() => {
  vi.useRealTimers();
});

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('SlidingWindowRateLimiter', () => {
  it('allows limit requests per window per key', () => {
    const c = clock(1000);
    const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 60_000, now: c.now });
    expect(limiter.consume('a')).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    c.advance(10_000);
    expect(limiter.consume('a')).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    expect(limiter.consume('a')).toEqual({ allowed: false, remaining: 0, retryAfterMs: 50_000 });
    expect(limiter.peek('a')).toEqual({ allowed: false, remaining: 0, retryAfterMs: 50_000 });
    expect(limiter.consume('b').allowed).toBe(true);
    c.advance(50_000);
    expect(limiter.peek('a')).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect(limiter.consume('a').allowed).toBe(true);
  });

  it('evicts idle keys instead of keeping one entry per user forever', () => {
    const c = clock();
    const limiter = new SlidingWindowRateLimiter({ limit: 5, windowMs: 1000, now: c.now });
    for (let i = 0; i < 100; i++) {
      limiter.consume(`user${i}`);
    }
    expect(limiter.size).toBe(100);
    c.advance(1000);
    limiter.consume('fresh');
    expect(limiter.size).toBe(1);
    c.advance(1000);
    expect(limiter.peek('fresh').remaining).toBe(5);
    expect(limiter.size).toBe(0);
    limiter.consume('x');
    limiter.consume('y');
    limiter.reset('x');
    expect(limiter.size).toBe(1);
    limiter.reset();
    expect(limiter.size).toBe(0);
  });

  it('validates its options and defaults to Date.now', () => {
    expect(() => new SlidingWindowRateLimiter({ limit: 0, windowMs: 1 })).toThrow('limit >= 1');
    expect(() => new SlidingWindowRateLimiter({ limit: 1, windowMs: 0 })).toThrow();
    expect(new SlidingWindowRateLimiter({ limit: 1, windowMs: 1000 }).consume('k').allowed).toBe(true);
  });
});

describe('TtlCache', () => {
  it('expires entries and sweeps them on write', () => {
    const c = clock();
    const cache = new TtlCache<string, number>({ ttlMs: 100, now: c.now });
    cache.set('a', 1).set('b', 2, 500);
    expect(cache.get('a')).toBe(1);
    expect(cache.has('b')).toBe(true);
    c.advance(100);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('missing')).toBeUndefined();
    cache.set('c', 3);
    c.advance(100);
    cache.set('d', 4);
    expect(cache.size).toBe(2);
    c.advance(400);
    expect(cache.size).toBe(0);
  });

  it('caps entries, dropping the least recently used', () => {
    const cache = new TtlCache<string, number>({ ttlMs: 10_000, maxEntries: 2 });
    cache.set('a', 1).set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.delete('a')).toBe(true);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('loads missing values once with getOrSet', async () => {
    const cache = new TtlCache<string, string>({ ttlMs: 1000 });
    const load = vi.fn(async () => 'v');
    expect(await cache.getOrSet('k', load)).toBe('v');
    expect(await cache.getOrSet('k', load)).toBe('v');
    expect(load).toHaveBeenCalledTimes(1);
    await expect(cache.getOrSet('bad', () => Promise.reject(new Error('no')))).rejects.toThrow('no');
    expect(cache.has('bad')).toBe(false);
  });

  it('validates its options', () => {
    expect(() => new TtlCache({ ttlMs: 0 })).toThrow('ttlMs > 0');
    expect(() => new TtlCache({ ttlMs: 1, maxEntries: 0 })).toThrow('maxEntries');
  });
});

describe('withConfirmTimeout', () => {
  it('passes an answer through', async () => {
    const confirm = withConfirmTimeout(async (name: string) => name === 'ok', { timeoutMs: 1000 });
    expect(await confirm('ok')).toBe(true);
    expect(await confirm('no')).toBe(false);
    expect(await withConfirmTimeout(() => 'yes' as unknown as boolean, { timeoutMs: 1000 })()).toBe(false);
  });

  it('answers no after the timeout, and says so', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const confirm = withConfirmTimeout(() => new Promise<boolean>(() => {}), { timeoutMs: 500, onTimeout });
    const answer = confirm();
    await vi.advanceTimersByTimeAsync(500);
    expect(await answer).toBe(false);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('answers no on a rejection or an abort', async () => {
    expect(await withConfirmTimeout(() => Promise.reject(new Error('gone')), { timeoutMs: 1000 })()).toBe(false);
    expect(
      await withConfirmTimeout(() => {
        throw new Error('sync');
      }, { timeoutMs: 1000 })(),
    ).toBe(false);
    const ac = new AbortController();
    const onTimeout = vi.fn();
    const answer = withConfirmTimeout(() => new Promise<boolean>(() => {}), { timeoutMs: 60_000, signal: ac.signal, onTimeout })();
    ac.abort();
    expect(await answer).toBe(false);
    expect(await withConfirmTimeout(async () => true, { timeoutMs: 1000, signal: ac.signal })()).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe('ConfirmationBroker', () => {
  it('sends a prompt and settles it from an answer', async () => {
    const broker = new ConfirmationBroker({ timeoutMs: 1000, createId: () => 'id1' });
    const send = vi.fn();
    const answer = broker.request({ send });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('id1', 1000));
    expect(broker.size).toBe(1);
    expect(broker.answer('nope', true)).toBe(false);
    expect(broker.answer('id1', true)).toBe(true);
    expect(await answer).toBe(true);
    expect(broker.size).toBe(0);
    expect(broker.answer('id1', false)).toBe(false);
  });

  it('expires unanswered prompts and cancels all on disconnect', async () => {
    vi.useFakeTimers();
    const broker = new ConfirmationBroker({ timeoutMs: 1000 });
    const ids: string[] = [];
    const onTimeout = vi.fn();
    const expired = broker.request({ send: (id) => ids.push(id), timeoutMs: 200, onTimeout });
    const cancelled = broker.request({ send: (id) => ids.push(id) });
    await vi.advanceTimersByTimeAsync(200);
    expect(await expired).toBe(false);
    expect(onTimeout).toHaveBeenCalledWith(ids[0]);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    broker.cancelAll();
    expect(await cancelled).toBe(false);
    expect(broker.size).toBe(0);
  });
});

describe('redactPairing', () => {
  it('removes pairing codes, also under matter and in arrays, without touching the input', () => {
    const status = { status: 'up', pin: '031-45-154', setupUri: 'X-HM://abc', matter: { pin: '1234', setupUri: 'MT:xyz', port: 5540 }, name: 'Bridge' };
    expect(redactPairing(status)).toEqual({ status: 'up', matter: { port: 5540 }, name: 'Bridge' });
    expect(status.pin).toBe('031-45-154');
    expect(status.matter.pin).toBe('1234');
    expect(redactPairing([{ name: 'a', matterPin: '1', matterSetupUri: 'u', pin: 'p' }, 3])).toEqual([{ name: 'a' }, 3]);
    expect(redactPairing({ matter: null, pin: 'x' })).toEqual({ matter: null });
    expect(redactPairing(null)).toBeNull();
    expect(redactPairing('031-45-154')).toBe('031-45-154');
    expect(PAIRING_KEYS).toContain('setupUri');
  });
});

describe('logs', () => {
  it('strips ANSI colour, cursor and erase codes', () => {
    expect(stripAnsi('\u001B[31mred\u001B[0m \u001B[1;32mgreen\u001B[39m\u001B[2K\u001B[1G')).toBe('red green');
    expect('\u001B[37m[x]'.replace(ANSI_PATTERN, '')).toBe('[x]');
  });

  it('keeps the last lines of text', () => {
    expect(tailLines('partial\nA\n\nB\r\nC\n', 2)).toEqual(['B', 'C']);
    expect(tailLines('partial\nA', 5, { dropFirst: true })).toEqual(['A']);
    expect(tailLines('A\n\nB', 5, { keepBlank: true })).toEqual(['A', '', 'B']);
    expect(tailLines('A', 0)).toEqual([]);
  });

  it('reads the tail of a log file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'logtail-'));
    const path = join(dir, 'homebridge.log');
    await writeFile(path, 'first line is long\n\u001B[32m[1] second\u001B[0m\n[2] third\n\n[3] fourth\n');
    expect(await readLogTail(path, 1024, 2)).toEqual(['[2] third', '[3] fourth']);
    expect(await readLogTail(path, 1024, 10)).toEqual(['first line is long', '[1] second', '[2] third', '[3] fourth']);
    // A window that starts mid-line drops the partial line.
    expect(await readLogTail(path, 30, 10)).toEqual(['[2] third', '[3] fourth']);
    await writeFile(path, '');
    expect(await readLogTail(path, 1024, 10)).toEqual([]);
    await expect(readLogTail(join(dir, 'missing.log'), 10, 10)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
