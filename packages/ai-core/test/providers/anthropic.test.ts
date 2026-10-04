import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_VERSION, AnthropicProvider, anthropicContextTokens } from '../../src/providers/anthropic.js';
import { ProviderError } from '../../src/providers/types.js';
import type { ChatChunk, ChatMessage } from '../../src/providers/types.js';
import { jsonResponse, sentBody, sentRequest, sseResponse, stubFetch } from './helpers.js';

const config = { model: 'claude-sonnet-5-5', apiKey: 'sk-ant-secret', maxOutputTokens: 1000 };

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

describe('AnthropicProvider', () => {
  it('requires an API key', () => {
    expect(() => new AnthropicProvider({ ...config, apiKey: undefined })).toThrow(ProviderError);
  });

  it('declares capabilities from the model', () => {
    expect(new AnthropicProvider(config).capabilities).toEqual({ tools: true, streaming: true, contextTokens: 1_000_000, jsonMode: false });
    expect(anthropicContextTokens('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(new AnthropicProvider({ ...config, contextTokens: 5000 }).capabilities.contextTokens).toBe(5000);
  });

  it('posts a Messages API request with tools and maps the reply', async () => {
    const fetchMock = stubFetch(
      jsonResponse({
        model: 'claude-sonnet-5-5',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: 'Turning it on.' },
          { type: 'tool_use', id: 'tu_1', name: 'set_accessory', input: { uniqueId: 'a', value: true } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 },
      }),
    );
    const provider = new AnthropicProvider(config);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Turn on the lamp' },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'tu_0', name: 'list_accessories', arguments: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'tu_0', name: 'list_accessories', content: 'boom', isError: true }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'tu_x', name: 'x', content: 'ok' }] },
    ];
    const result = await provider.chat({
      system: 'sys',
      messages,
      tools: [{ name: 'set_accessory', inputSchema: { type: 'object' } }],
      maxOutputTokens: 50,
    });

    const { url, headers } = sentRequest(fetchMock);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers['x-api-key']).toBe('sk-ant-secret');
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    const body = sentBody(fetchMock);
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 50, cache_control: { type: 'ephemeral' } });
    expect(body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    expect(body.tools).toEqual([{ name: 'set_accessory', description: '', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }]);
    expect(body.output_config).toBeUndefined();
    expect(body.messages[1].content[0]).toEqual({ type: 'tool_use', id: 'tu_0', name: 'list_accessories', input: {} });
    expect(body.messages[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu_0', content: 'boom', is_error: true });
    expect(body.messages[3].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu_x', content: 'ok' });
    expect(body.stream).toBeUndefined();

    expect(result.text).toBe('Turning it on.');
    expect(result.toolCalls).toEqual([{ id: 'tu_1', name: 'set_accessory', arguments: { uniqueId: 'a', value: true } }]);
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 7, cacheReadTokens: 5 });
    expect(result.stopReason).toBe('tool_calls');
    expect(result.message.providerContent?.provider).toBe('anthropic');
  });

  it('sends its own earlier turns back verbatim (thinking blocks included)', async () => {
    const fetchMock = stubFetch(jsonResponse({ content: [], stop_reason: 'weird', usage: {} }));
    const raw = [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'hi' }];
    const result = await new AnthropicProvider({ ...config, baseUrl: 'https://proxy' }).chat({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'hi', providerContent: { provider: 'anthropic', content: raw } },
      ],
    });
    expect(sentRequest(fetchMock).url).toBe('https://proxy/v1/messages');
    const body = sentBody(fetchMock);
    expect(body.messages[1].content).toEqual(raw);
    expect(body.max_tokens).toBe(1000);
    expect(body.system).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(result.stopReason).toBe('other');
    expect(result.model).toBe('claude-sonnet-5-5');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('puts the cache breakpoint on the last tool only, and can turn caching off', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ content: [], stop_reason: 'end_turn', usage: {} }),
      jsonResponse({ content: [], stop_reason: 'end_turn', usage: {} }),
    );
    const tools = [
      { name: 'a', inputSchema: { type: 'object' } },
      { name: 'b', description: 'B', inputSchema: { type: 'object' } },
    ];
    await new AnthropicProvider(config).chat({ system: 's', messages: [], tools });
    let body = sentBody(fetchMock, 0);
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });

    await new AnthropicProvider({ ...config, promptCaching: false }).chat({ system: 's', messages: [], tools });
    body = sentBody(fetchMock, 1);
    expect(body.system).toBe('s');
    expect(body.cache_control).toBeUndefined();
    expect(body.tools.every((t: Record<string, unknown>) => !('cache_control' in t))).toBe(true);
  });

  it('sends effort as output_config, per provider or per request', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ content: [], stop_reason: 'end_turn', usage: {} }),
      jsonResponse({ content: [], stop_reason: 'end_turn', usage: {} }),
    );
    const provider = new AnthropicProvider({ ...config, effort: 'high' });
    await provider.chat({ messages: [] });
    await provider.chat({ messages: [], effort: 'low' });
    expect(sentBody(fetchMock, 0).output_config).toEqual({ effort: 'high' });
    expect(sentBody(fetchMock, 1).output_config).toEqual({ effort: 'low' });
  });

  it('reports cache writes and reads as parts of the input', async () => {
    stubFetch(
      jsonResponse({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0, output_tokens: 4 },
      }),
    );
    const { usage } = await new AnthropicProvider(config).chat({ messages: [] });
    expect(usage).toEqual({ inputTokens: 3020, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 3000 });
  });

  it('turns HTTP errors into a ProviderError without the key', async () => {
    stubFetch(jsonResponse({ error: { message: 'invalid x-api-key sk-ant-secretsecretsecret' } }, 401));
    const error = await new AnthropicProvider(config).chat({ messages: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(401);
    expect(error.message).toContain('HTTP 401');
    expect(error.message).not.toContain('secretsecret');
  });

  it('streams text, thinking and tool calls', async () => {
    const fetchMock = stubFetch(
      sseResponse([
        { event: 'message_start', data: { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 12, output_tokens: 1 } } } },
        { event: 'ping', data: { type: 'ping' } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: 'orphan' } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_1', name: 'get_config', input: {} } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"includeSe' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'crets":false}' } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]),
    );
    const chunks = await collect(new AnthropicProvider(config).stream({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(sentBody(fetchMock).stream).toBe(true);
    expect(chunks.filter((c) => c.type === 'text').map((c) => (c as { delta: string }).delta)).toEqual(['Hel', 'lo']);
    expect(chunks.find((c) => c.type === 'tool_call')).toEqual({ type: 'tool_call', id: 'tu_1', name: 'get_config', arguments: { includeSecrets: false } });
    const done = chunks.at(-1) as Extract<ChatChunk, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.usage).toEqual({ inputTokens: 12, outputTokens: 30 });
    expect(done.stopReason).toBe('tool_calls');
    expect(done.result.text).toBe('Hello');
    expect(done.result.message.providerContent?.content).toEqual([
      { type: 'thinking', thinking: 'hm', signature: 'SIG' },
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'tu_1', name: 'get_config', input: { includeSecrets: false } },
    ]);
  });

  it('throws on a stream error event and on malformed data', async () => {
    stubFetch(sseResponse([{ event: 'error', data: { type: 'error', error: { message: 'overloaded' } } }]));
    await expect(collect(new AnthropicProvider(config).stream({ messages: [] }))).rejects.toThrow('overloaded');
    stubFetch(sseResponse([{ event: 'error', data: { type: 'error' } }]));
    await expect(collect(new AnthropicProvider(config).stream({ messages: [] }))).rejects.toThrow('stream error');
    stubFetch(sseResponse(['{not json']));
    await expect(collect(new AnthropicProvider(config).stream({ messages: [] }))).rejects.toThrow('malformed stream event');
  });

  it('rejects tool input that is not JSON', async () => {
    stubFetch(
      sseResponse([
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'x', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
        { type: 'content_block_stop', index: 0 },
      ]),
    );
    await expect(collect(new AnthropicProvider(config).stream({ messages: [] }))).rejects.toThrow('not valid JSON');
  });
});
