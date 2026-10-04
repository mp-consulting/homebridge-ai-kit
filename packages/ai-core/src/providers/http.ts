/** fetch + Server-Sent Events plumbing shared by the provider adapters. */

import type { ProviderName } from '../core/config.js';
import { redactText } from '../core/redaction.js';
import type { ChatMessage, ContentPart } from './types.js';
import { ProviderError } from './types.js';

/** How {@link postJson} retries transient failures. */
export interface RetryOptions {
  /** Retries after the first attempt (default 2; 0 disables retrying). */
  maxRetries?: number;
  /** First backoff step in ms (default 500); doubles per attempt, with full jitter. */
  baseDelayMs?: number;
  /** Upper bound of one backoff step in ms (default 8000). */
  maxDelayMs?: number;
  /** Longest `retry-after` the client waits for, in ms (default 60000); a longer one fails at once. */
  maxRetryAfterMs?: number;
}

export const DEFAULT_RETRY: Readonly<Required<RetryOptions>> = Object.freeze({
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 60_000,
});

/** Statuses worth retrying: timeout, rate limit, server errors and Anthropic's 529 overloaded. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * The wait a `retry-after` (seconds or an HTTP date) or `retry-after-ms`
 * header asks for, in ms; undefined when absent or unparseable.
 */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | undefined {
  const ms = Number(headers.get('retry-after-ms') ?? NaN);
  if (Number.isFinite(ms) && ms >= 0) {
    return ms;
  }
  const value = headers.get('retry-after')?.trim();
  if (!value) {
    return undefined;
  }
  if (/^\d+(\.\d+)?$/.test(value)) {
    return Number(value) * 1000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Full-jitter exponential backoff for retry `attempt` (0-based): a random wait up to `min(maxDelay, base * 2^attempt)`. */
export function backoffDelay(attempt: number, options: RetryOptions = {}, random: () => number = Math.random): number {
  const base = options.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const cap = options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  return Math.round(random() * Math.min(cap, base * 2 ** attempt));
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * POST JSON, turning network failures and non-2xx statuses into a {@link ProviderError}.
 * Network errors and 408 / 429 / 5xx responses are retried with jittered
 * exponential backoff, waiting at least as long as a `retry-after` header asks
 * (a wait over `maxRetryAfterMs` fails at once). An aborted `signal` stops
 * retrying immediately. Streaming requests retry only until the response
 * starts: once the body is being read, a failure is final.
 */
export async function postJson(
  provider: ProviderName,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
  retry: RetryOptions = {},
): Promise<Response> {
  const maxRetries = Math.max(0, retry.maxRetries ?? DEFAULT_RETRY.maxRetries);
  const maxRetryAfter = retry.maxRetryAfterMs ?? DEFAULT_RETRY.maxRetryAfterMs;
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    let failure: ProviderError;
    let retryAfter: number | undefined;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: payload,
        signal,
      });
      if (res.ok) {
        return res;
      }
      const text = await res.text().catch(() => '');
      failure = new ProviderError(provider, `HTTP ${res.status}: ${errorDetail(text)}`, res.status);
      if (!isRetryableStatus(res.status)) {
        throw failure;
      }
      retryAfter = parseRetryAfter(res.headers);
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
      failure = new ProviderError(provider, `cannot reach ${new URL(url).origin}${cause}`);
    }
    if (attempt >= maxRetries || (retryAfter !== undefined && retryAfter > maxRetryAfter)) {
      throw failure;
    }
    await sleep(Math.max(retryAfter ?? 0, backoffDelay(attempt, retry)), signal);
  }
}

/** The useful part of a provider error body, with anything key-like redacted. */
function errorDetail(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message);
    if (message) {
      return redactText(message);
    }
  } catch {
    // not JSON
  }
  return redactText(text.slice(0, 500)) || 'no details';
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Parses a `text/event-stream` body into events. */
export async function* readSse(res: Response): AsyncGenerator<SseEvent> {
  if (!res.body) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];

  const flush = (): SseEvent | undefined => {
    const out = data.length > 0 ? { event, data: data.join('\n') } : undefined;
    event = undefined;
    data = [];
    return out;
  };

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line === '') {
        const ev = flush();
        if (ev) {
          yield ev;
        }
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      }
    }
  }
  if (buffer.startsWith('data:')) {
    data.push(buffer.slice(5).replace(/^ /, ''));
  }
  const last = flush();
  if (last) {
    yield last;
  }
}

/** Parse the JSON payload of an SSE event. */
export function parseEvent<T>(provider: ProviderName, data: string): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    throw new ProviderError(provider, `malformed stream event: ${data.slice(0, 200)}`);
  }
}

/** Parses tool-call arguments, which providers send as a JSON string. */
export function parseArguments(provider: ProviderName, raw: string | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new ProviderError(provider, `tool call arguments are not valid JSON: ${raw.slice(0, 200)}`);
  }
}

/** A message's content as parts. */
export function partsOf(message: ChatMessage): ContentPart[] {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
}
