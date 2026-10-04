/**
 * OpenAI Chat Completions (`POST /chat/completions`), plain fetch. Also serves
 * any OpenAI-compatible server (Ollama, LM Studio, vLLM) via `baseUrl`.
 */

import type { AiConfig } from '../core/config.js';
import { DEFAULT_BASE_URLS, DEFAULT_MAX_OUTPUT_TOKENS } from '../core/config.js';
import { parseArguments, parseEvent, partsOf, postJson, readSse } from './http.js';
import type {
  AiProvider,
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ContentPart,
  ProviderCapabilities,
  StopReason,
  ToolCall,
} from './types.js';
import { ProviderError, retryOptions } from './types.js';
import type { ProviderRetryOptions } from './types.js';
import type { RetryOptions } from './http.js';

type OpenAiName = 'openai' | 'openai-compatible';

interface ApiToolCall {
  index?: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ApiToolCall[];
  tool_call_id?: string;
}

interface ApiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** OpenAI's automatic prompt caching: the cached part of `prompt_tokens`. */
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

const STOP_REASONS: Record<string, StopReason> = {
  stop: 'end',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
  length: 'max_tokens',
  content_filter: 'refusal',
};

export function toOpenAiMessages(system: string | undefined, messages: ChatMessage[]): ApiMessage[] {
  const out: ApiMessage[] = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    const parts = partsOf(m);
    const text = parts
      .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('');
    if (m.role === 'assistant') {
      const calls = parts.filter((p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call');
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
          : {}),
      });
      continue;
    }
    for (const p of parts) {
      if (p.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: p.toolCallId, content: p.isError ? `Error: ${p.content}` : p.content });
      }
    }
    if (text) {
      out.push({ role: 'user', content: text });
    }
  }
  return out;
}

function buildResult(model: string, text: string, toolCalls: ToolCall[], finish: string | null | undefined, usage: ApiUsage | undefined): ChatResult {
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      ...(usage?.prompt_tokens_details?.cached_tokens !== undefined ? { cacheReadTokens: usage.prompt_tokens_details.cached_tokens } : {}),
    },
    stopReason: toolCalls.length > 0 ? 'tool_calls' : (STOP_REASONS[finish ?? ''] ?? 'other'),
    model,
    message: {
      role: 'assistant',
      content: [...(text ? [{ type: 'text' as const, text }] : []), ...toolCalls.map((c) => ({ type: 'tool_call' as const, ...c }))],
    },
  };
}

export interface OpenAiProviderOptions extends Pick<AiConfig, 'model' | 'apiKey' | 'baseUrl' | 'maxOutputTokens' | 'contextTokens'>, ProviderRetryOptions {
  name?: OpenAiName;
  capabilities?: Partial<ProviderCapabilities>;
}

export class OpenAiProvider implements AiProvider {
  readonly name: OpenAiName;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly maxOutputTokens: number;
  private readonly retry: RetryOptions;

  constructor(options: OpenAiProviderOptions) {
    this.name = options.name ?? 'openai';
    if (this.name === 'openai' && !options.apiKey) {
      throw new ProviderError('openai', 'an API key is required');
    }
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.url = `${options.baseUrl ?? DEFAULT_BASE_URLS[this.name]}/chat/completions`;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.retry = retryOptions(options);
    this.capabilities = {
      tools: true,
      streaming: true,
      contextTokens: options.contextTokens ?? (this.name === 'openai' ? 128_000 : 8_192),
      jsonMode: this.name === 'openai',
      ...options.capabilities,
    };
  }

  private post(req: ChatRequest, stream: boolean): Promise<Response> {
    const maxTokens = req.maxOutputTokens ?? this.maxOutputTokens;
    const tools = this.capabilities.tools && req.tools?.length ? req.tools : undefined;
    const body = {
      model: this.model,
      messages: toOpenAiMessages(req.system, req.messages),
      // OpenAI deprecated max_tokens for newer models; compatible servers mostly only know max_tokens.
      ...(this.name === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      ...(tools
        ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema } })) }
        : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
    return postJson(this.name, this.url, this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}, body, req.signal, this.retry);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const res = await this.post(req, false);
    const data = (await res.json()) as { choices?: Array<{ message?: ApiMessage; finish_reason?: string }>; usage?: ApiUsage; model?: string };
    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new ProviderError(this.name, 'response has no choices');
    }
    const toolCalls = (choice.message.tool_calls ?? []).map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.function?.name ?? '',
      arguments: parseArguments(this.name, c.function?.arguments),
    }));
    return buildResult(data.model ?? this.model, choice.message.content ?? '', toolCalls, choice.finish_reason, data.usage);
  }

  async *stream(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const res = await this.post(req, true);
    let text = '';
    let finish: string | undefined;
    let usage: ApiUsage | undefined;
    let model = this.model;
    const pending: Array<{ id: string; name: string; args: string }> = [];

    for await (const ev of readSse(res)) {
      if (ev.data === '[DONE]') {
        break;
      }
      const data = parseEvent<{
        model?: string;
        choices?: Array<{ delta?: { content?: string | null; tool_calls?: ApiToolCall[] }; finish_reason?: string | null }>;
        usage?: ApiUsage | null;
        error?: { message?: string };
      }>(this.name, ev.data);
      if (data.error) {
        throw new ProviderError(this.name, data.error.message ?? 'stream error');
      }
      model = data.model ?? model;
      usage = data.usage ?? usage;
      const choice = data.choices?.[0];
      if (!choice) {
        continue;
      }
      finish = choice.finish_reason ?? finish;
      if (choice.delta?.content) {
        text += choice.delta.content;
        yield { type: 'text', delta: choice.delta.content };
      }
      for (const tc of choice.delta?.tool_calls ?? []) {
        const i = tc.index ?? pending.length;
        pending[i] ??= { id: tc.id ?? `call_${i}`, name: '', args: '' };
        pending[i].id = tc.id ?? pending[i].id;
        pending[i].name += tc.function?.name ?? '';
        pending[i].args += tc.function?.arguments ?? '';
      }
    }

    const toolCalls: ToolCall[] = pending.filter(Boolean).map((p) => ({ id: p.id, name: p.name, arguments: parseArguments(this.name, p.args) }));
    for (const call of toolCalls) {
      yield { type: 'tool_call', ...call };
    }
    const result = buildResult(model, text, toolCalls, finish, usage);
    yield { type: 'done', usage: result.usage, stopReason: result.stopReason, result };
  }
}
