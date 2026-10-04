import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiProvider, toOpenAiMessages, toResponsesInput } from '../../src/providers/openai.js';
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

const openai = () => new OpenAiProvider({ model: 'gpt-6.1-sol', apiKey: 'sk-openai', maxOutputTokens: 500, maxRetries: 0 });
const openaiChat = () => new OpenAiProvider({ model: 'gpt-5', apiKey: 'sk-openai', maxOutputTokens: 500, maxRetries: 0, api: 'chat' });

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

describe('OpenAiProvider (Chat Completions)', () => {
  it('requires a key for OpenAI but not for compatible servers', () => {
    expect(() => new OpenAiProvider({ model: 'gpt-5', maxOutputTokens: 1 })).toThrow(ProviderError);
    const local = new OpenAiProvider({ name: 'openai-compatible', model: 'llama3.1', maxOutputTokens: 1 });
    expect(local.capabilities).toEqual({ tools: true, streaming: true, contextTokens: 8192, jsonMode: false });
    expect(local.api).toBe('chat');
    expect(openai().capabilities.contextTokens).toBe(128_000);
    expect(openai().api).toBe('responses');
  });

  it('posts a chat completion with tools and parses tool calls', async () => {
    const fetchMock = stubFetch(
      jsonResponse({
        model: 'gpt-5-2026',
        choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"x":2}' } }, { function: { name: 'g' } }] } }],
        usage: { prompt_tokens: 9, completion_tokens: 3 },
      }),
    );
    const result = await new OpenAiProvider({ model: 'gpt-5', apiKey: 'sk-openai', maxOutputTokens: 500, maxRetries: 0, api: 'chat', effort: 'high' }).chat({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'f', description: 'F', inputSchema: { type: 'object' } }],
    });
    const { url, headers } = sentRequest(fetchMock);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(sentBody(fetchMock).reasoning_effort).toBe('high');
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
    const provider = new OpenAiProvider({ name: 'openai-compatible', model: 'llama', baseUrl: 'http://ollama:11434/v1', maxOutputTokens: 64, effort: 'low' });
    const result = await provider.chat({ messages: [{ role: 'user', content: 'x' }], tools: [] });
    expect(sentRequest(fetchMock).url).toBe('http://ollama:11434/v1/chat/completions');
    expect(sentRequest(fetchMock).headers.Authorization).toBeUndefined();
    expect(sentBody(fetchMock)).toMatchObject({ max_tokens: 64, model: 'llama' });
    expect(sentBody(fetchMock).tools).toBeUndefined();
    expect(sentBody(fetchMock).reasoning_effort).toBeUndefined();
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
    await expect(openaiChat().chat({ messages: [] })).rejects.toThrow('no choices');
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
    const chunks = await collect(openaiChat().stream({ messages: [{ role: 'user', content: 'x' }] }));
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
    await expect(collect(openaiChat().stream({ messages: [] }))).rejects.toThrow('rate limited');
    stubFetch(sseResponse([{ error: {} }]));
    await expect(collect(openaiChat().stream({ messages: [] }))).rejects.toThrow('stream error');
  });

  it('handles a stream without a trailing blank line or [DONE]', async () => {
    stubFetch(sseResponse([], { raw: 'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}' }));
    const chunks = await collect(openaiChat().stream({ messages: [] }));
    expect((chunks.at(-1) as Extract<ChatChunk, { type: 'done' }>).result).toMatchObject({ text: 'x', stopReason: 'end' });
  });

  it('handles a response without a body', async () => {
    stubFetch(new Response(null, { status: 200 }));
    const chunks = await collect(openaiChat().stream({ messages: [] }));
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

describe('toResponsesInput', () => {
  it('maps text, tool calls and tool results to input items', () => {
    expect(
      toResponsesInput([
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
        { role: 'assistant', content: [{ type: 'tool_call', id: 'c3', name: 'h', arguments: {} }] },
      ]),
    ).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'calling' },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      { type: 'function_call_output', call_id: 'c2', output: 'Error: bad' },
      { role: 'user', content: 'and?' },
      { type: 'function_call', call_id: 'c3', name: 'h', arguments: '{}' },
    ]);
  });

  it("replays this provider's own output items verbatim, and only its own", () => {
    const items = [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' }, { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' }];
    const turn = { role: 'assistant' as const, content: 'x', providerContent: { provider: 'openai' as const, content: items } };
    expect(toResponsesInput([turn])).toEqual(items);
    expect(toResponsesInput([turn], 'openai-compatible')).toEqual([{ role: 'assistant', content: 'x' }]);
    expect(toResponsesInput([{ ...turn, providerContent: { provider: 'openai', content: 'not items' } }])).toEqual([{ role: 'assistant', content: 'x' }]);
  });
});

describe('OpenAiProvider (Responses API)', () => {
  const tools = [{ name: 'f', description: 'F', inputSchema: { type: 'object' } }, { name: 'g', inputSchema: { type: 'object' } }];

  it('posts to /responses with instructions, flat function tools, store: false and reasoning effort', async () => {
    const fetchMock = stubFetch(
      jsonResponse({
        model: 'gpt-6.1-sol-2026',
        status: 'completed',
        output: [
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me check.' }] },
          { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'f', arguments: '{"x":2}' },
          { type: 'function_call', id: 'fc_2', name: 'g' },
          { type: 'function_call' },
        ],
        usage: { input_tokens: 90, output_tokens: 30, input_tokens_details: { cached_tokens: 64 } },
      }),
    );
    const provider = new OpenAiProvider({ model: 'gpt-6.1-sol', apiKey: 'sk-openai', maxOutputTokens: 500, maxRetries: 0, effort: 'medium' });
    const result = await provider.chat({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools, effort: 'xhigh' });
    const { url, headers } = sentRequest(fetchMock);
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(headers.Authorization).toBe('Bearer sk-openai');
    expect(sentBody(fetchMock)).toEqual({
      model: 'gpt-6.1-sol',
      instructions: 's',
      input: [{ role: 'user', content: 'hi' }],
      max_output_tokens: 500,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'xhigh' },
      tools: [
        { type: 'function', name: 'f', description: 'F', parameters: { type: 'object' } },
        { type: 'function', name: 'g', description: '', parameters: { type: 'object' } },
      ],
    });
    expect(result).toMatchObject({
      text: 'Let me check.',
      model: 'gpt-6.1-sol-2026',
      stopReason: 'tool_calls',
      usage: { inputTokens: 90, outputTokens: 30, cacheReadTokens: 64 },
      toolCalls: [
        { id: 'call_a', name: 'f', arguments: { x: 2 } },
        { id: 'fc_2', name: 'g', arguments: {} },
        { id: 'call_4', name: '', arguments: {} },
      ],
    });
    expect(result.message.providerContent?.provider).toBe('openai');

    // The next request replays the output items (reasoning included) before the tool results.
    stubFetch(jsonResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }] }));
    const next = await provider.chat({
      messages: [
        { role: 'user', content: 'hi' },
        result.message,
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 'call_a', name: 'f', content: '42' }] },
      ],
    });
    expect(next).toMatchObject({ text: 'Done', stopReason: 'end', model: 'gpt-6.1-sol', usage: { inputTokens: 0, outputTokens: 0 } });
    expect(next.usage.cacheReadTokens).toBeUndefined();
  });

  it('sends no instructions, reasoning or tools when there are none', async () => {
    const fetchMock = stubFetch(jsonResponse({ status: 'completed', output: [] }));
    await openai().chat({ messages: [{ role: 'user', content: 'x' }], tools: [], maxOutputTokens: 77 });
    const body = sentBody(fetchMock);
    expect(body).toMatchObject({ max_output_tokens: 77, store: false });
    expect(body.instructions).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.stream).toBeUndefined();
  });

  it('maps incomplete, refusal and other statuses to stop reasons', async () => {
    const cases: Array<[unknown, string, string]> = [
      [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'cut' }] }] }, 'max_tokens', 'cut'],
      [{ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }, 'refusal', ''],
      [{ status: 'incomplete', output: [] }, 'other', ''],
      [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }, { type: 'refusal' }] }] }, 'refusal', 'No.'],
      [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }, { type: 'refusal', refusal: 'meh' }, { type: 'other' }] }] }, 'end', 'ok'],
      [{ status: 'completed', output: [{ type: 'message' }, { type: 'message', content: [{ type: 'output_text' }] }] }, 'end', ''],
      [{ status: 'in_progress', output: [] }, 'other', ''],
    ];
    for (const [response, stopReason, text] of cases) {
      stubFetch(jsonResponse(response));
      expect(await openai().chat({ messages: [] })).toMatchObject({ stopReason, text });
    }
  });

  it('rejects a failed response or one without output', async () => {
    stubFetch(jsonResponse({ status: 'failed', error: { code: 'server_error', message: 'boom' } }));
    await expect(openai().chat({ messages: [] })).rejects.toThrow('openai: boom');
    stubFetch(jsonResponse({ status: 'failed', error: null }));
    await expect(openai().chat({ messages: [] })).rejects.toThrow('response failed');
    stubFetch(jsonResponse({ status: 'completed' }));
    await expect(openai().chat({ messages: [] })).rejects.toThrow('response has no output');
  });

  it('rejects tool arguments that are not JSON', async () => {
    stubFetch(jsonResponse({ status: 'completed', output: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{oops' }] }));
    await expect(openai().chat({ messages: [] })).rejects.toThrow('not valid JSON');
  });

  it('retries a 429 and surfaces HTTP errors', async () => {
    const fetchMock = stubFetch(
      new Response('', { status: 429, headers: { 'retry-after-ms': '0' } }),
      jsonResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }),
    );
    const provider = new OpenAiProvider({ model: 'gpt-6.1-sol', apiKey: 'k', maxOutputTokens: 10, maxRetries: 1, retry: { baseDelayMs: 0 } });
    expect((await provider.chat({ messages: [] })).text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stubFetch(jsonResponse({ error: { message: 'Invalid model' } }, 400));
    await expect(openai().chat({ messages: [] })).rejects.toThrow('HTTP 400: Invalid model');
  });

  it('passes the abort signal to fetch', async () => {
    const fetchMock = stubFetch(jsonResponse({ status: 'completed', output: [] }));
    const controller = new AbortController();
    await openai().chat({ messages: [], signal: controller.signal });
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(controller.signal);
  });

  it('streams text deltas and function calls from semantic events', async () => {
    const final = {
      model: 'gpt-6.1-sol-2026',
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'set_accessory', arguments: '{"v":1}' },
      ],
      usage: { input_tokens: 40, output_tokens: 12, input_tokens_details: { cached_tokens: 32 } },
    };
    const fetchMock = stubFetch(
      sseResponse([
        { event: 'response.created', data: { type: 'response.created', response: { model: 'gpt-6.1-sol-2026', status: 'in_progress' } } },
        { type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant', content: [] } },
        { type: 'response.output_text.delta', output_index: 1, delta: 'He' },
        { type: 'response.output_text.delta', output_index: 1, delta: '' },
        { type: 'response.output_text.delta', output_index: 1, delta: 'llo' },
        { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'set_accessory', arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"v"' },
        { type: 'response.function_call_arguments.delta', output_index: 2, delta: ':1}' },
        { type: 'response.function_call_arguments.done', output_index: 2, arguments: '{"v":1}' },
        { type: 'response.completed', response: final },
      ]),
    );
    const chunks = await collect(openai().stream({ messages: [{ role: 'user', content: 'x' }], tools }));
    expect(sentBody(fetchMock)).toMatchObject({ stream: true, store: false });
    expect(sentBody(fetchMock).stream_options).toBeUndefined();
    expect(chunks.filter((c) => c.type === 'text').map((c) => (c as { delta: string }).delta)).toEqual(['He', 'llo']);
    expect(chunks.filter((c) => c.type === 'tool_call')).toEqual([{ type: 'tool_call', id: 'call_a', name: 'set_accessory', arguments: { v: 1 } }]);
    const done = chunks.at(-1) as Extract<ChatChunk, { type: 'done' }>;
    expect(done).toMatchObject({ usage: { inputTokens: 40, outputTokens: 12, cacheReadTokens: 32 }, stopReason: 'tool_calls' });
    expect(done.result).toMatchObject({ text: 'Hello', model: 'gpt-6.1-sol-2026' });
    expect(done.result.message.providerContent).toEqual({ provider: 'openai', content: final.output });
  });

  it('assembles what arrived when the stream ends before response.completed', async () => {
    stubFetch(
      sseResponse([
        { type: 'response.in_progress', response: { model: 'gpt-6.1-sol-x' } },
        { type: 'response.in_progress', response: {} },
        { type: 'response.output_text.delta', delta: 'Hi' },
        { type: 'response.output_item.added', output_index: 3, item: { type: 'function_call', call_id: 'c2', name: 'g' } },
        { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'c1', name: 'f', arguments: '' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
        { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"a":' },
        { type: 'response.function_call_arguments.delta', output_index: 1 },
        { type: 'response.function_call_arguments.delta', output_index: 3, delta: '{}' },
        { type: 'response.function_call_arguments.delta', output_index: 9, delta: 'lost' },
        { type: 'response.function_call_arguments.done', output_index: 9, arguments: 'lost' },
        { type: 'response.function_call_arguments.done', output_index: 3 },
        { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"a":1}' } },
        { type: 'response.function_call_arguments.delta' },
        { type: 'response.unknown_event' },
        '[DONE]',
        { type: 'response.output_text.delta', delta: 'ignored' },
      ]),
    );
    const chunks = await collect(openai().stream({ messages: [] }));
    expect(chunks.filter((c) => c.type === 'tool_call')).toEqual([
      { type: 'tool_call', id: 'c1', name: 'f', arguments: { a: 1 } },
      { type: 'tool_call', id: 'c2', name: 'g', arguments: {} },
    ]);
    const done = chunks.at(-1) as Extract<ChatChunk, { type: 'done' }>;
    expect(done).toMatchObject({ stopReason: 'tool_calls', usage: { inputTokens: 0, outputTokens: 0 } });
    expect(done.result).toMatchObject({ text: 'Hi', model: 'gpt-6.1-sol-x' });
  });

  it('reports an incomplete stream and a stream without a body', async () => {
    stubFetch(
      sseResponse([
        { type: 'response.output_text.delta', delta: 'cut' },
        { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 7 } } },
      ]),
    );
    const chunks = await collect(openai().stream({ messages: [] }));
    expect(chunks.at(-1)).toMatchObject({ type: 'done', stopReason: 'max_tokens', usage: { inputTokens: 5, outputTokens: 7 }, result: { text: 'cut' } });

    stubFetch(new Response(null, { status: 200 }));
    const empty = await collect(openai().stream({ messages: [] }));
    expect(empty).toEqual([expect.objectContaining({ type: 'done', stopReason: 'other', result: expect.objectContaining({ text: '' }) })]);
  });

  it('throws on response.failed and error events', async () => {
    stubFetch(sseResponse([{ type: 'response.failed', response: { status: 'failed', error: { message: 'model crashed' } } }]));
    await expect(collect(openai().stream({ messages: [] }))).rejects.toThrow('model crashed');
    stubFetch(sseResponse([{ type: 'response.failed' }]));
    await expect(collect(openai().stream({ messages: [] }))).rejects.toThrow('response failed');
    stubFetch(sseResponse([{ type: 'error', code: 'rate_limit_exceeded', message: 'slow down' }]));
    await expect(collect(openai().stream({ messages: [] }))).rejects.toThrow('slow down');
    stubFetch(sseResponse([{ type: 'error', error: { message: 'nested' } }]));
    await expect(collect(openai().stream({ messages: [] }))).rejects.toThrow('nested');
    stubFetch(sseResponse([{ type: 'error' }]));
    await expect(collect(openai().stream({ messages: [] }))).rejects.toThrow('stream error');
    stubFetch(sseResponse([], { raw: 'data: {not json\n\n' }));
    await expect(collect(openai().stream({ messages: [] }))).rejects.toThrow('malformed stream event');
  });

  it('can call /responses on an OpenAI-compatible server', async () => {
    const fetchMock = stubFetch(jsonResponse({ status: 'completed', output: [] }));
    const provider = new OpenAiProvider({ name: 'openai-compatible', api: 'responses', model: 'qwen3', baseUrl: 'http://lm:1234/v1', maxOutputTokens: 9, effort: 'low' });
    const result = await provider.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(sentRequest(fetchMock).url).toBe('http://lm:1234/v1/responses');
    expect(sentRequest(fetchMock).headers.Authorization).toBeUndefined();
    expect(sentBody(fetchMock).include).toBeUndefined();
    expect(sentBody(fetchMock).reasoning).toEqual({ effort: 'low' });
    expect(result.message.providerContent?.provider).toBe('openai-compatible');
  });
});
