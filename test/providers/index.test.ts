import { describe, expect, it, vi } from 'vitest';
import { resolveAiConfig } from '../../src/core/config.js';
import { AnthropicProvider, GeminiProvider, OpenAiProvider, complete, createProvider } from '../../src/providers/index.js';
import type { AiProvider } from '../../src/providers/types.js';
import { fakeProvider } from './helpers.js';

describe('createProvider', () => {
  it('builds the adapter for each provider', () => {
    expect(createProvider(resolveAiConfig({ provider: 'anthropic', apiKey: 'k' }))).toBeInstanceOf(AnthropicProvider);
    expect(createProvider(resolveAiConfig({ provider: 'openai', apiKey: 'k' }))).toBeInstanceOf(OpenAiProvider);
    expect(createProvider(resolveAiConfig({ provider: 'gemini', apiKey: 'k' }))).toBeInstanceOf(GeminiProvider);
    const local = createProvider(resolveAiConfig({ provider: 'openai-compatible' }));
    expect(local).toBeInstanceOf(OpenAiProvider);
    expect(local.name).toBe('openai-compatible');
  });

  it('rejects an unknown provider', () => {
    expect(() => createProvider({ ...resolveAiConfig({}), provider: 'apple' as never })).toThrow('Unknown AI provider "apple"');
  });
});

describe('complete', () => {
  it('uses chat when no callback is given', async () => {
    const { provider } = fakeProvider([{ text: 'hello' }]);
    expect((await complete(provider, { messages: [] })).text).toBe('hello');
    expect(provider.stream).not.toHaveBeenCalled();
  });

  it('streams to the callback', async () => {
    const { provider } = fakeProvider([{ text: 'hello' }]);
    const onChunk = vi.fn();
    expect((await complete(provider, { messages: [] }, onChunk)).text).toBe('hello');
    expect(onChunk.mock.calls).toEqual([['hel'], ['lo']]);
  });

  it('falls back to one chunk for providers that cannot stream', async () => {
    const { provider } = fakeProvider([{ text: 'hello' }, { text: '' }], { streaming: false });
    const onChunk = vi.fn();
    await complete(provider, { messages: [] }, onChunk);
    await complete(provider, { messages: [] }, onChunk);
    expect(onChunk.mock.calls).toEqual([['hello']]);
  });

  it('fails when a stream ends without a result', async () => {
    const provider = {
      name: 'openai',
      capabilities: { streaming: true },
      async *stream() {
        yield { type: 'text', delta: 'x' };
      },
    } as unknown as AiProvider;
    await expect(complete(provider, { messages: [] }, () => {})).rejects.toThrow('stream ended without a result');
  });
});
