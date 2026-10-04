import type { AiConfig } from '../core/config.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { OpenAiProvider } from './openai.js';
import type { AiProvider, ChatChunk, ChatRequest, ChatResult } from './types.js';

export * from './types.js';
export { AnthropicProvider } from './anthropic.js';
export { GeminiProvider } from './gemini.js';
export { OpenAiProvider } from './openai.js';

/** Builds the provider adapter an {@link AiConfig} selects. */
export function createProvider(config: AiConfig): AiProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAiProvider({ ...config, name: 'openai' });
    case 'gemini':
      return new GeminiProvider(config);
    case 'openai-compatible':
      return new OpenAiProvider({ ...config, name: 'openai-compatible' });
    default:
      throw new Error(`Unknown AI provider "${(config as { provider: unknown }).provider}"`);
  }
}

/**
 * One call that streams text to `onChunk` when the provider can stream and a
 * callback is given, and returns the final result either way.
 */
export async function complete(provider: AiProvider, request: ChatRequest, onChunk?: (delta: string) => void): Promise<ChatResult> {
  if (!onChunk || !provider.capabilities.streaming) {
    const result = await provider.chat(request);
    if (onChunk && result.text) {
      onChunk(result.text);
    }
    return result;
  }
  let done: ChatResult | undefined;
  for await (const chunk of provider.stream(request) as AsyncIterable<ChatChunk>) {
    if (chunk.type === 'text') {
      onChunk(chunk.delta);
    } else if (chunk.type === 'done') {
      done = chunk.result;
    }
  }
  if (!done) {
    throw new Error(`${provider.name}: the stream ended without a result`);
  }
  return done;
}
