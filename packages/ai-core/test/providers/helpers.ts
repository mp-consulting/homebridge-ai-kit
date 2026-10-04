import { vi } from 'vitest';
import type { AiProvider, ChatChunk, ChatRequest, ChatResult, ProviderCapabilities, ToolCall } from '../../src/providers/types.js';

/** A Response whose body is the given SSE events (`data:` lines, optional `event:`). */
export function sseResponse(events: Array<unknown | { event: string; data: unknown }>, { raw }: { raw?: string } = {}): Response {
  const text =
    raw ??
    events
      .map((e) => {
        if (typeof e === 'object' && e !== null && 'event' in e && 'data' in e) {
          const ev = e as { event: string; data: unknown };
          return `event: ${ev.event}\ndata: ${typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)}\n\n`;
        }
        return `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`;
      })
      .join('');
  // Split into small chunks to exercise buffering across reads.
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) {
        controller.enqueue(bytes.slice(i, i + 7));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Stub global fetch with queued responses; returns the mock for inspecting calls. */
export function stubFetch(...responses: Array<Response | Error>) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error('unexpected fetch');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The parsed JSON body of the n-th fetch call. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sentBody(fetchMock: ReturnType<typeof stubFetch>, n = 0): any {
  const init = (fetchMock.mock.calls[n] as unknown as [string, RequestInit])[1];
  return JSON.parse(init.body as string);
}

export function sentRequest(fetchMock: ReturnType<typeof stubFetch>, n = 0): { url: string; headers: Record<string, string> } {
  const [url, init] = fetchMock.mock.calls[n] as unknown as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string> };
}

export type Reply = { text?: string; toolCalls?: ToolCall[]; stopReason?: ChatResult['stopReason'] };

/** A scripted provider: each call returns the next reply. Records every request. */
export function fakeProvider(replies: Reply[], capabilities: Partial<ProviderCapabilities> = {}) {
  const requests: ChatRequest[] = [];
  const next = (req: ChatRequest): ChatResult => {
    requests.push(structuredClone({ ...req, signal: undefined }));
    const reply = replies.shift();
    if (!reply) {
      throw new Error('no more replies');
    }
    const toolCalls = reply.toolCalls ?? [];
    const text = reply.text ?? '';
    return {
      text,
      toolCalls,
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: reply.stopReason ?? (toolCalls.length ? 'tool_calls' : 'end'),
      model: 'fake-model',
      message: {
        role: 'assistant',
        content: [...(text ? [{ type: 'text' as const, text }] : []), ...toolCalls.map((c) => ({ type: 'tool_call' as const, ...c }))],
      },
    };
  };
  const provider: AiProvider = {
    name: 'anthropic',
    model: 'fake-model',
    capabilities: { tools: true, streaming: true, contextTokens: 100_000, jsonMode: false, ...capabilities },
    chat: vi.fn(async (req: ChatRequest) => next(req)),
    stream: vi.fn(async function* (req: ChatRequest): AsyncGenerator<ChatChunk> {
      const result = next(req);
      if (result.text) {
        yield { type: 'text', delta: result.text.slice(0, 3) };
        yield { type: 'text', delta: result.text.slice(3) };
      }
      for (const call of result.toolCalls) {
        yield { type: 'tool_call', ...call };
      }
      yield { type: 'done', usage: result.usage, stopReason: result.stopReason, result };
    }),
  };
  return { provider, requests };
}
