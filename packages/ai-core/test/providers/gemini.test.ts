import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider, toGeminiSchema } from '../../src/providers/gemini.js';
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

const gemini = () => new GeminiProvider({ model: 'gemini-2.5-pro', apiKey: 'AIza-key', maxOutputTokens: 800 });

describe('toGeminiSchema', () => {
  it('keeps the supported subset and maps nullable type arrays', () => {
    expect(
      toGeminiSchema({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        additionalProperties: false,
        properties: {
          a: { type: ['string', 'null'], description: 'A' },
          b: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 } },
          c: { anyOf: [{ type: 'string' }, { type: 'boolean' }] },
          d: { type: ['null'] },
        },
        required: ['a'],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string', nullable: true, description: 'A' },
        b: { type: 'array', items: { type: 'number' } },
        c: { anyOf: [{ type: 'string' }, { type: 'boolean' }] },
        d: { type: 'string', nullable: true },
      },
      required: ['a'],
    });
    expect(toGeminiSchema('x')).toBe('x');
  });
});

describe('GeminiProvider', () => {
  it('requires an API key', () => {
    expect(() => new GeminiProvider({ model: 'm', maxOutputTokens: 1 })).toThrow(ProviderError);
    expect(gemini().capabilities).toEqual({ tools: true, streaming: true, contextTokens: 1_048_576, jsonMode: true });
  });

  it('calls generateContent with function declarations and maps the reply', async () => {
    const fetchMock = stubFetch(
      jsonResponse({
        modelVersion: 'gemini-2.5-pro-001',
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                { text: 'thinking…', thought: true },
                { text: 'Sure. ' },
                { functionCall: { name: 'list_accessories', args: { room: 'Kitchen' } }, thoughtSignature: 'abc' },
                { functionCall: { id: 'g2', name: 'get_config' } },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, thoughtsTokenCount: 6 },
      }),
    );
    const result = await gemini().chat({
      system: 'sys',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_call', id: 'x', name: 'f', arguments: { a: 1 } }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolCallId: 'x', name: 'f', content: 'ok' },
            { type: 'tool_result', toolCallId: 'y', name: 'g', content: 'bad', isError: true },
          ],
        },
      ],
      tools: [{ name: 'f', inputSchema: { type: 'object', additionalProperties: false } }],
    });
    const { url, headers } = sentRequest(fetchMock);
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
    expect(headers['x-goog-api-key']).toBe('AIza-key');
    const body = sentBody(fetchMock);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 800 });
    expect(body.tools).toEqual([{ functionDeclarations: [{ name: 'f', description: '', parameters: { type: 'object' } }] }]);
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'f', response: { content: 'ok' } } }, { functionResponse: { name: 'g', response: { error: 'bad' } } }],
      },
    ]);
    expect(result).toMatchObject({
      text: 'Sure. ',
      model: 'gemini-2.5-pro-001',
      stopReason: 'tool_calls',
      usage: { inputTokens: 20, outputTokens: 10 },
      toolCalls: [
        { id: 'call_0', name: 'list_accessories', arguments: { room: 'Kitchen' } },
        { id: 'g2', name: 'get_config', arguments: {} },
      ],
    });
    expect((result.message.providerContent?.content as unknown[])[2]).toMatchObject({ thoughtSignature: 'abc' });
  });

  it('replays its own turns verbatim and handles an empty reply', async () => {
    const fetchMock = stubFetch(jsonResponse({ candidates: [{ finishReason: 'SAFETY' }] }));
    const parts = [{ functionCall: { name: 'f', args: {} }, thoughtSignature: 'sig' }];
    const result = await gemini().chat({ messages: [{ role: 'assistant', content: '', providerContent: { provider: 'gemini', content: parts } }] });
    expect(sentBody(fetchMock).contents).toEqual([{ role: 'model', parts }]);
    expect(sentBody(fetchMock).systemInstruction).toBeUndefined();
    expect(result).toMatchObject({ text: '', stopReason: 'refusal', usage: { inputTokens: 0, outputTokens: 0 }, model: 'gemini-2.5-pro' });
    stubFetch(jsonResponse({}));
    expect((await gemini().chat({ messages: [] })).stopReason).toBe('other');
  });

  it('streams over SSE', async () => {
    const fetchMock = stubFetch(
      sseResponse([
        { candidates: [{ content: { parts: [{ text: 'thought', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'lo' }, { text: '' }] } }], modelVersion: 'gemini-x' },
        { candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: { a: 1 } } }, { functionCall: { id: 'id2', name: 'g' } }] } }] },
        { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, cachedContentTokenCount: 1 } },
        {},
      ]),
    );
    const chunks = await collect(new GeminiProvider({ model: 'gemini-2.5-flash', apiKey: 'k', baseUrl: 'https://g/v1beta', maxOutputTokens: 1 }).stream({ messages: [] }));
    expect(sentRequest(fetchMock).url).toBe('https://g/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(chunks.filter((c) => c.type === 'text').map((c) => (c as { delta: string }).delta)).toEqual(['Hel', 'lo']);
    expect(chunks.filter((c) => c.type === 'tool_call')).toEqual([
      { type: 'tool_call', id: 'call_0', name: 'f', arguments: { a: 1 } },
      { type: 'tool_call', id: 'id2', name: 'g', arguments: {} },
    ]);
    const done = chunks.at(-1) as Extract<ChatChunk, { type: 'done' }>;
    expect(done).toMatchObject({ usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1 }, stopReason: 'tool_calls' });
    expect(done.result.model).toBe('gemini-x');
  });

  it('throws on a streamed error', async () => {
    stubFetch(sseResponse([{ error: { message: 'quota' } }]));
    await expect(collect(gemini().stream({ messages: [] }))).rejects.toThrow('quota');
    stubFetch(sseResponse([{ error: {} }]));
    await expect(collect(gemini().stream({ messages: [] }))).rejects.toThrow('stream error');
  });
});
