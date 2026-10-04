/** fetch + Server-Sent Events plumbing shared by the provider adapters. */

import type { ProviderName } from '../core/config.js';
import { redactText } from '../core/redaction.js';
import type { ChatMessage, ContentPart } from './types.js';
import { ProviderError } from './types.js';

/** POST JSON, turning network failures and non-2xx statuses into a {@link ProviderError}. */
export async function postJson(
  provider: ProviderName,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
    throw new ProviderError(provider, `cannot reach ${new URL(url).origin}${cause}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError(provider, `HTTP ${res.status}: ${errorDetail(text)}`, res.status);
  }
  return res;
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
