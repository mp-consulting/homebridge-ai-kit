import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RETRY, backoffDelay, isRetryableStatus, parseRetryAfter, postJson, sleep } from '../../src/providers/http.js';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { GeminiProvider } from '../../src/providers/gemini.js';
import { ProviderError, retryOptions } from '../../src/providers/types.js';
import { jsonResponse, sseResponse, stubFetch } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const fast = { baseDelayMs: 0, maxDelayMs: 0 };
const post = (retry = {}, signal?: AbortSignal) => postJson('openai', 'https://api.example.com/v1/x', { a: 'b' }, { q: 1 }, signal, { ...fast, ...retry });

describe('retry helpers', () => {
  it('knows which statuses to retry', () => {
    for (const status of [408, 429, 500, 502, 503, 529]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it('parses retry-after as seconds, an HTTP date or retry-after-ms', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    expect(parseRetryAfter(new Headers({ 'retry-after': '3' }), now)).toBe(3000);
    expect(parseRetryAfter(new Headers({ 'retry-after': '1.5' }), now)).toBe(1500);
    expect(parseRetryAfter(new Headers({ 'retry-after': 'Sun, 04 Oct 2026 12:00:10 GMT' }), now)).toBe(10_000);
    expect(parseRetryAfter(new Headers({ 'retry-after': 'Sun, 04 Oct 2026 11:00:00 GMT' }), now)).toBe(0);
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250', 'retry-after': '9' }), now)).toBe(250);
    expect(parseRetryAfter(new Headers({ 'retry-after': 'soon' }), now)).toBeUndefined();
    expect(parseRetryAfter(new Headers({ 'retry-after': ' ' }), now)).toBeUndefined();
    expect(parseRetryAfter(new Headers(), now)).toBeUndefined();
    expect(parseRetryAfter(new Headers({ 'retry-after': '1' }))).toBe(1000);
  });

  it('backs off exponentially with full jitter, capped', () => {
    expect(backoffDelay(0, {}, () => 1)).toBe(DEFAULT_RETRY.baseDelayMs);
    expect(backoffDelay(2, {}, () => 1)).toBe(DEFAULT_RETRY.baseDelayMs * 4);
    expect(backoffDelay(10, {}, () => 1)).toBe(DEFAULT_RETRY.maxDelayMs);
    expect(backoffDelay(3, { baseDelayMs: 100, maxDelayMs: 10_000 }, () => 0.5)).toBe(400);
    expect(backoffDelay(3, {}, () => 0)).toBe(0);
    const d = backoffDelay(1);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(1000);
  });

  it('sleeps, and stops at an abort', async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
    const ac = new AbortController();
    const pending = sleep(60_000, ac.signal);
    ac.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
    await expect(sleep(1, ac.signal)).rejects.toThrow('stop');
    const plain = new AbortController();
    const listener = sleep(5, plain.signal);
    await expect(listener).resolves.toBeUndefined();
  });

  it('falls back to an AbortError when the signal has no reason', async () => {
    const signal = { aborted: true, reason: undefined } as unknown as AbortSignal;
    await expect(sleep(1, signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('merges maxRetries into the retry options', () => {
    expect(retryOptions({})).toEqual({});
    expect(retryOptions({ maxRetries: 0, retry: { maxRetries: 5, baseDelayMs: 1 } })).toEqual({ maxRetries: 0, baseDelayMs: 1 });
    expect(retryOptions({ retry: { maxRetries: 5 } })).toEqual({ maxRetries: 5 });
  });
});

describe('postJson retries', () => {
  it('retries 429 / 5xx / 529 and network errors, then succeeds', async () => {
    const fetchMock = stubFetch(
      new Response('slow down', { status: 429 }),
      new Response('{"error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529 }),
      new TypeError('fetch failed'),
      jsonResponse({ ok: true }),
    );
    const res = await post({ maxRetries: 3 });
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const init = (fetchMock.mock.calls[3] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe('{"q":1}');
  });

  it('gives up after maxRetries with the last error', async () => {
    const fetchMock = stubFetch(new Response('', { status: 503 }), new Response('', { status: 502 }), new Response('', { status: 500 }));
    await expect(post()).rejects.toThrow('HTTP 500: no details');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry client errors', async () => {
    const fetchMock = stubFetch(jsonResponse({ error: { message: 'bad' } }, 400));
    const error = await post().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry with maxRetries 0', async () => {
    const fetchMock = stubFetch(new Response('', { status: 503 }));
    await expect(post({ maxRetries: 0 })).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('waits as long as retry-after asks', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(new Response('', { status: 429, headers: { 'retry-after': '2' } }), jsonResponse({}));
    const pending = post();
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeInstanceOf(Response);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails at once when retry-after is over the cap', async () => {
    const fetchMock = stubFetch(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
    await expect(post({ maxRetryAfterMs: 60_000 })).rejects.toThrow('HTTP 429');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when the signal aborts during the backoff', async () => {
    const ac = new AbortController();
    const fetchMock = stubFetch(new Response('', { status: 503, headers: { 'retry-after': '30' } }));
    const pending = post({}, ac.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    ac.abort(new DOMException('aborted', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a fetch rejected because the signal aborted', async () => {
    const ac = new AbortController();
    ac.abort(new DOMException('timed out', 'TimeoutError'));
    const timeout = new DOMException('timed out', 'TimeoutError');
    const fetchMock = stubFetch(timeout);
    await expect(post({}, ac.signal)).rejects.toBe(timeout);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('applies to every provider, streaming included', async () => {
    const fetchMock = stubFetch(
      new Response('', { status: 529 }),
      sseResponse([{ type: 'message_start', message: { usage: { input_tokens: 1 } } }, { type: 'message_stop' }]),
      new Response('', { status: 500 }),
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }),
    );
    const claude = new AnthropicProvider({ model: 'claude-sonnet-5-5', apiKey: 'k', maxOutputTokens: 100, retry: fast });
    const chunks = [];
    for await (const c of claude.stream({ messages: [{ role: 'user', content: 'x' }] })) {
      chunks.push(c);
    }
    expect(chunks.at(-1)).toMatchObject({ type: 'done' });
    const gemini = new GeminiProvider({ model: 'gemini-2.5-pro', apiKey: 'k', maxOutputTokens: 100, maxRetries: 1, retry: fast });
    expect((await gemini.chat({ messages: [{ role: 'user', content: 'x' }] })).text).toBe('hi');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
