/**
 * OpenAI over plain fetch: the Responses API (`POST /responses`, the default for
 * OpenAI, which newer models need for tool calling) or Chat Completions
 * (`POST /chat/completions`, the default for OpenAI-compatible servers such as
 * Ollama, LM Studio and vLLM, set with `baseUrl`).
 */

import type { AiConfig, EffortLevel, OpenAiApi } from '../core/config.js';
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

// ── Responses API ──

/** A Responses API output item; input items are the same shapes (plus `function_call_output`). */
interface OutputItem {
  type: string;
  id?: string;
  role?: string;
  content?: Array<{ type: string; text?: string; refusal?: string }>;
  call_id?: string;
  name?: string;
  arguments?: string;
  [key: string]: unknown;
}

type InputItem =
  | { role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | OutputItem;

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  /** OpenAI's automatic prompt caching: the cached part of `input_tokens`. */
  input_tokens_details?: { cached_tokens?: number } | null;
}

interface ResponseObject {
  model?: string;
  status?: string;
  output?: OutputItem[];
  usage?: ResponsesUsage | null;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string; code?: string } | null;
}

interface StreamEvent {
  type?: string;
  delta?: string;
  arguments?: string;
  output_index?: number;
  item?: OutputItem;
  response?: ResponseObject;
  message?: string;
  error?: { message?: string } | null;
}

/**
 * The conversation as Responses API input items. An assistant turn this provider
 * produced is replayed verbatim (its reasoning items carry the encrypted
 * reasoning that `store: false` needs to continue a tool loop).
 */
export function toResponsesInput(messages: ChatMessage[], provider: OpenAiName = 'openai'): InputItem[] {
  const out: InputItem[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.providerContent?.provider === provider && Array.isArray(m.providerContent.content)) {
      out.push(...(m.providerContent.content as OutputItem[]));
      continue;
    }
    const parts = partsOf(m);
    const text = parts
      .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('');
    if (m.role === 'assistant') {
      if (text) {
        out.push({ role: 'assistant', content: text });
      }
      for (const p of parts) {
        if (p.type === 'tool_call') {
          out.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: JSON.stringify(p.arguments) });
        }
      }
      continue;
    }
    for (const p of parts) {
      if (p.type === 'tool_result') {
        out.push({ type: 'function_call_output', call_id: p.toolCallId, output: p.isError ? `Error: ${p.content}` : p.content });
      }
    }
    if (text) {
      out.push({ role: 'user', content: text });
    }
  }
  return out;
}

const INCOMPLETE_REASONS: Record<string, StopReason> = {
  max_output_tokens: 'max_tokens',
  content_filter: 'refusal',
};

function fromResponse(provider: OpenAiName, fallbackModel: string, response: ResponseObject): ChatResult {
  const output = response.output ?? [];
  let text = '';
  let refusal = '';
  const toolCalls: ToolCall[] = [];
  output.forEach((item, i) => {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text') {
          text += part.text ?? '';
        } else if (part.type === 'refusal') {
          refusal += part.refusal ?? '';
        }
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: item.call_id ?? item.id ?? `call_${i}`, name: item.name ?? '', arguments: parseArguments(provider, item.arguments) });
    }
  });
  let stopReason: StopReason;
  if (toolCalls.length > 0) {
    stopReason = 'tool_calls';
  } else if (response.status === 'incomplete') {
    stopReason = INCOMPLETE_REASONS[response.incomplete_details?.reason ?? ''] ?? 'other';
  } else if (refusal && !text) {
    stopReason = 'refusal';
  } else {
    stopReason = response.status === 'completed' ? 'end' : 'other';
  }
  text ||= refusal;
  const usage = response.usage ?? undefined;
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      ...(usage?.input_tokens_details?.cached_tokens !== undefined ? { cacheReadTokens: usage.input_tokens_details.cached_tokens } : {}),
    },
    stopReason,
    model: response.model ?? fallbackModel,
    message: {
      role: 'assistant',
      content: [...(text ? [{ type: 'text' as const, text }] : []), ...toolCalls.map((c) => ({ type: 'tool_call' as const, ...c }))],
      providerContent: { provider, content: output },
    },
  };
}

export interface OpenAiProviderOptions
  extends Pick<AiConfig, 'model' | 'apiKey' | 'baseUrl' | 'maxOutputTokens' | 'contextTokens' | 'effort'>, ProviderRetryOptions {
  name?: OpenAiName;
  /** `responses` (default for `openai`) or `chat` (default for `openai-compatible`, for servers that only speak Chat Completions). */
  api?: OpenAiApi;
  capabilities?: Partial<ProviderCapabilities>;
}

export class OpenAiProvider implements AiProvider {
  readonly name: OpenAiName;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  /** The API this provider calls. */
  readonly api: OpenAiApi;
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly maxOutputTokens: number;
  private readonly effort?: EffortLevel;
  private readonly retry: RetryOptions;

  constructor(options: OpenAiProviderOptions) {
    this.name = options.name ?? 'openai';
    if (this.name === 'openai' && !options.apiKey) {
      throw new ProviderError('openai', 'an API key is required');
    }
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.api = options.api ?? (this.name === 'openai' ? 'responses' : 'chat');
    this.url = `${options.baseUrl ?? DEFAULT_BASE_URLS[this.name]}/${this.api === 'responses' ? 'responses' : 'chat/completions'}`;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.effort = options.effort;
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
    const body = this.api === 'responses' ? this.responsesBody(req, stream) : this.chatBody(req, stream);
    return postJson(this.name, this.url, this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}, body, req.signal, this.retry);
  }

  private tools(req: ChatRequest) {
    return this.capabilities.tools && req.tools?.length ? req.tools : undefined;
  }

  private responsesBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const tools = this.tools(req);
    const effort = req.effort ?? this.effort;
    return {
      model: this.model,
      ...(req.system ? { instructions: req.system } : {}),
      input: toResponsesInput(req.messages, this.name),
      max_output_tokens: req.maxOutputTokens ?? this.maxOutputTokens,
      // Nothing is kept on OpenAI's side; each request carries the whole conversation.
      store: false,
      // Reasoning models: get the reasoning back encrypted so a tool loop can replay it without `store`.
      ...(this.name === 'openai' ? { include: ['reasoning.encrypted_content'] } : {}),
      ...(effort ? { reasoning: { effort } } : {}),
      ...(tools ? { tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description ?? '', parameters: t.inputSchema })) } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }

  private chatBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const maxTokens = req.maxOutputTokens ?? this.maxOutputTokens;
    const tools = this.tools(req);
    const effort = req.effort ?? this.effort;
    return {
      model: this.model,
      messages: toOpenAiMessages(req.system, req.messages),
      // OpenAI deprecated max_tokens for newer models; compatible servers mostly only know max_tokens.
      ...(this.name === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      ...(this.name === 'openai' && effort ? { reasoning_effort: effort } : {}),
      ...(tools
        ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema } })) }
        : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    return this.api === 'responses' ? this.chatResponses(req) : this.chatCompletions(req);
  }

  stream(req: ChatRequest): AsyncGenerator<ChatChunk> {
    return this.api === 'responses' ? this.streamResponses(req) : this.streamCompletions(req);
  }

  private failure(response: ResponseObject | undefined, fallback: string): ProviderError {
    return new ProviderError(this.name, response?.error?.message ?? fallback);
  }

  private async chatResponses(req: ChatRequest): Promise<ChatResult> {
    const res = await this.post(req, false);
    const data = (await res.json()) as ResponseObject;
    if (data.status === 'failed' || data.error) {
      throw this.failure(data, 'response failed');
    }
    if (!Array.isArray(data.output)) {
      throw new ProviderError(this.name, 'response has no output');
    }
    return fromResponse(this.name, this.model, data);
  }

  private async *streamResponses(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const res = await this.post(req, true);
    let text = '';
    let model = this.model;
    let final: ResponseObject | undefined;
    const calls = new Map<number, OutputItem>();

    for await (const ev of readSse(res)) {
      if (ev.data === '[DONE]') {
        break;
      }
      const data = parseEvent<StreamEvent>(this.name, ev.data);
      const index = data.output_index ?? -1;
      switch (data.type) {
        case 'response.created':
        case 'response.in_progress':
          model = data.response?.model ?? model;
          break;
        case 'response.output_text.delta':
          if (data.delta) {
            text += data.delta;
            yield { type: 'text', delta: data.delta };
          }
          break;
        case 'response.output_item.added':
        case 'response.output_item.done':
          if (data.item?.type === 'function_call') {
            calls.set(index, { arguments: '', ...calls.get(index), ...data.item });
          }
          break;
        case 'response.function_call_arguments.delta': {
          const call = calls.get(index);
          if (call) {
            call.arguments = (call.arguments ?? '') + (data.delta ?? '');
          }
          break;
        }
        case 'response.function_call_arguments.done': {
          const call = calls.get(index);
          if (call && data.arguments !== undefined) {
            call.arguments = data.arguments;
          }
          break;
        }
        case 'response.completed':
        case 'response.incomplete':
          final = data.response;
          break;
        case 'response.failed':
          throw this.failure(data.response, 'response failed');
        case 'error':
          throw new ProviderError(this.name, data.message ?? data.error?.message ?? 'stream error');
      }
    }

    // A stream cut short of `response.completed` still yields what arrived.
    const arrived: OutputItem[] = [
      ...(text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] : []),
      ...[...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
    ];
    const response: ResponseObject = final?.output ? final : { ...final, model, output: arrived };
    const result = fromResponse(this.name, model, response);
    for (const call of result.toolCalls) {
      yield { type: 'tool_call', ...call };
    }
    yield { type: 'done', usage: result.usage, stopReason: result.stopReason, result };
  }

  // ── Chat Completions ──

  private async chatCompletions(req: ChatRequest): Promise<ChatResult> {
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

  private async *streamCompletions(req: ChatRequest): AsyncGenerator<ChatChunk> {
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
