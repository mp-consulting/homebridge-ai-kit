import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiProvider, toOpenAiMessages } from '../../src/providers/openai.js';
import { ProviderError } from '../../src/providers/types.js';
import type { ChatChunk } from '../../src/providers/types.js';
import { jsonResponse, sentBody, sentRequest, sseResponse, stubFetch } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) {
    out.push(c);
  }
  return out;
}

const openai = () => new OpenAiProvider({ model: 'gpt-5', apiKey: 'sk-openai', maxOutputTokens: 500, maxRetries: 0 });

describe('toOpenAiMessages', () => {
  it('maps system, text, tool calls and tool results', () => {
    expect(
      toOpenAiMessages('sys', [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_call', id: 'c1', name: 'f', arguments: { a: 1 } }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolCallId: 'c1', name: 'f', content: 'ok' },
            { type: 'tool_result', toolCallId: 'c2', name: 'g', content: 'bad', isError: true },
            { type: 'text', text: 'and?' },
          ],
        },
        { role: 'assistant', content: 'done' },
      ]),
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'calling', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'tool', tool_call_id: 'c2', content: 'Error: bad' },
      { role: 'user', content: 'and?' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('sends null content for a tool-only assistant turn', () => {
    expect(toOpenAiMessages(undefined, [{ role: 'assistant', content: [{ type: 'tool_call', id: 'c', name: 'f', arguments: {} }] }])[0].content).toBeNull();
  });
});

describe('OpenAiProvider', () => {
  it('requires a key for OpenAI but not for compatible servers', () => {
    expect(() => new OpenAiProvider({ model: 'gpt-5', maxOutputTokens: 1 })).toThrow(ProviderError);
    const local = new OpenAiProvider({ name: 'openai-compatible', model: 'llama3.1', maxOutputTokens: 1 });
    expect(local.capabilities).toEqual({ tools: true, streaming: true, contextTokens: 8192, jsonMode: false });
    expect(openai().capabilities.contextTokens).toBe(128_000);
  });

  it('posts a chat completion with tools and parses tool calls', async () => {
    const fetchMock = stubFetch(
      jsonResponse({
        model: 'gpt-5-2026',
        choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"x":2}' } }, { function: { name: 'g' } }] } }],
        usage: { prompt_tokens: 9, completion_tokens: 3 },
      }),
    );
    const result = await openai().chat({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'f', description: 'F', inputSchema: { type: 'object' } }] });
    const { url, headers } = sentRequest(fetchMock);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(headers.Authorization).toBe('Bearer sk-openai');
    const body = sentBody(fetchMock);
    expect(body.max_completion_tokens).toBe(500);
    expect(body.max_tokens).toBeUndefined();
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'f', description: 'F', parameters: { type: 'object' } } }]);
    expect(result).toMatchObject({
      text: '',
      model: 'gpt-5-2026',
      stopReason: 'tool_calls',
      usage: { inputTokens: 9, outputTokens: 3 },
      toolCalls: [{ id: 'c1', name: 'f', arguments: { x: 2 } }, { id: 'call_1', name: 'g', arguments: {} }],
    });
  });

  it('uses max_tokens, no auth header and the base URL for compatible servers', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'hi' } }] }));
    const provider = new OpenAiProvider({ name: 'openai-compatible', model: 'llama', baseUrl: 'http://ollama:11434/v1', maxOutputTokens: 64 });
    const result = await provider.chat({ messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(sentRequest(fetchMock).url).toBe('http://ollama:11434/v1/chat/completions');
    expect(sentRequest(fetchMock).headers.Authorization).toBeUndefined();
    expect(sentBody(fetchMock)).toMatchObject({ max_tokens: 64, model: 'llama' });
    expect(sentBody(fetchMock).tools).toBeUndefined();
    expect(result).toMatchObject({ text: 'hi', stopReason: 'max_tokens', model: 'llama', usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it('drops tools when the capabilities say the model has none', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'x' } }] }));
    const provider = new OpenAiProvider({ name: 'openai-compatible', model: 'm', maxOutputTokens: 1, capabilities: { tools: false } });
    await provider.chat({ messages: [], tools: [{ name: 'f', inputSchema: {} }] });
    expect(sentBody(fetchMock).tools).toBeUndefined();
  });

  it('rejects a reply without choices', async () => {
    stubFetch(jsonResponse({}));
    await expect(openai().chat({ messages: [] })).rejects.toThrow('no choices');
  });

  it('reports network failures with the host', async () => {
    stubFetch(Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') }));
    await expect(openai().chat({ messages: [] })).rejects.toThrow('cannot reach https://api.openai.com: ECONNREFUSED');
    stubFetch(new TypeError('fetch failed'));
    await expect(openai().chat({ messages: [] })).rejects.toThrow(/cannot reach https:\/\/api.openai.com$/);
  });

  it('passes aborts through untouched', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    stubFetch(abort);
    await expect(openai().chat({ messages: [] })).rejects.toBe(abort);
  });

  it('streams text and assembles tool-call fragments', async () => {
    const fetchMock = stubFetch(
      sseResponse([
        { model: 'gpt-5-x', choices: [{ delta: { role: 'assistant', content: 'He' } }] },
        { choices: [{ delta: { content: 'llo' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'set_', arguments: '{"v"' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'accessory', arguments: ':1}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ function: { name: 'get', arguments: '' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } },
        '[DONE]',
        { choices: [{ delta: { content: 'ignored' } }] },
      ]),
    );
    const chunks = await collect(openai().stream({ messages: [{ role: 'user', content: 'x' }] }));
    expect(sentBody(fetchMock)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(chunks.filter((c) => c.type === 'text').map((c) => (c as { delta: string }).delta)).toEqual(['He', 'llo']);
    expect(chunks.filter((c) => c.type === 'tool_call')).toEqual([
      { type: 'tool_call', id: 'c1', name: 'set_accessory', arguments: { v: 1 } },
      { type: 'tool_call', id: 'call_1', name: 'get', arguments: {} },
    ]);
    const done = chunks.at(-1) as Extract<ChatChunk, { type: 'done' }>;
    expect(done).toMatchObject({ usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 3 }, stopReason: 'tool_calls' });
    expect(done.result).toMatchObject({ text: 'Hello', model: 'gpt-5-x' });
  });

  it('throws on a stream error payload', async () => {
    stubFetch(sseResponse([{ error: { message: 'rate limited' } }]));
    await expect(collect(openai().stream({ messages: [] }))).rejects.toThrow('rate limited');
    stubFetch(sseResponse([{ error: {} }]));
    await expect(collect(openai().stream({ messages: [] }))).rejects.toThrow('stream error');
  });

  it('handles a stream without a trailing blank line or [DONE]', async () => {
    stubFetch(sseResponse([], { raw: 'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}' }));
    const chunks = await collect(openai().stream({ messages: [] }));
    expect((chunks.at(-1) as Extract<ChatChunk, { type: 'done' }>).result).toMatchObject({ text: 'x', stopReason: 'end' });
  });

  it('handles a response without a body', async () => {
    stubFetch(new Response(null, { status: 200 }));
    const chunks = await collect(openai().stream({ messages: [] }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('done');
  });

  it('summarises non-JSON error bodies', async () => {
    stubFetch(new Response('Bad Gateway', { status: 502 }));
    await expect(openai().chat({ messages: [] })).rejects.toThrow('HTTP 502: Bad Gateway');
    stubFetch(new Response('', { status: 500 }));
    await expect(openai().chat({ messages: [] })).rejects.toThrow('HTTP 500: no details');
    stubFetch(jsonResponse({ error: 'plain string' }, 400));
    await expect(openai().chat({ messages: [] })).rejects.toThrow('HTTP 400: plain string');
    stubFetch(jsonResponse({ message: 'top-level' }, 400));
    await expect(openai().chat({ messages: [] })).rejects.toThrow('HTTP 400: top-level');
  });
});
