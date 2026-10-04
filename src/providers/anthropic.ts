/** Claude via the Anthropic Messages API (`POST /v1/messages`), plain fetch. */

import type { AiConfig } from '../core/config.js';
import { DEFAULT_BASE_URLS, DEFAULT_MAX_OUTPUT_TOKENS } from '../core/config.js';
import { parseArguments, parseEvent, partsOf, postJson, readSse } from './http.js';
import type {
  AiProvider,
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ProviderCapabilities,
  StopReason,
  TokenUsage,
  ToolCall,
} from './types.js';
import { ProviderError } from './types.js';

export const ANTHROPIC_VERSION = '2023-06-01';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [key: string]: unknown };

interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ApiMessage {
  content: Block[];
  stop_reason: string | null;
  usage: ApiUsage;
  model?: string;
}

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: 'end',
  stop_sequence: 'end',
  tool_use: 'tool_calls',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
};

function inputTokens(u: ApiUsage): number {
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
}

/** Claude context window: 200K for Haiku, 1M for the current Opus/Sonnet/Fable generations. */
export function anthropicContextTokens(model: string): number {
  return /haiku/.test(model) ? 200_000 : 1_000_000;
}

function toApiMessages(messages: ChatMessage[]): Array<{ role: string; content: Block[] }> {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.providerContent?.provider === 'anthropic') {
      return { role: 'assistant', content: m.providerContent.content as Block[] };
    }
    const content = partsOf(m).map((p): Block => {
      switch (p.type) {
        case 'text':
          return { type: 'text', text: p.text };
        case 'tool_call':
          return { type: 'tool_use', id: p.id, name: p.name, input: p.arguments };
        case 'tool_result':
          return { type: 'tool_result', tool_use_id: p.toolCallId, content: p.content, ...(p.isError ? { is_error: true } : {}) };
      }
    });
    return { role: m.role, content };
  });
}

function toResult(model: string, msg: ApiMessage): ChatResult {
  const text = msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const toolCalls: ToolCall[] = msg.content
    .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, arguments: b.input ?? {} }));
  const usage: TokenUsage = { inputTokens: inputTokens(msg.usage), outputTokens: msg.usage.output_tokens ?? 0 };
  return {
    text,
    toolCalls,
    usage,
    stopReason: STOP_REASONS[msg.stop_reason ?? ''] ?? 'other',
    model: msg.model ?? model,
    message: {
      role: 'assistant',
      content: [...(text ? [{ type: 'text' as const, text }] : []), ...toolCalls.map((c) => ({ type: 'tool_call' as const, ...c }))],
      providerContent: { provider: 'anthropic', content: msg.content },
    },
  };
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly maxOutputTokens: number;

  constructor(config: Pick<AiConfig, 'model' | 'apiKey' | 'baseUrl' | 'maxOutputTokens' | 'contextTokens'>) {
    if (!config.apiKey) {
      throw new ProviderError('anthropic', 'an API key is required');
    }
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.url = `${config.baseUrl ?? DEFAULT_BASE_URLS.anthropic}/v1/messages`;
    this.maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.capabilities = {
      tools: true,
      streaming: true,
      contextTokens: config.contextTokens ?? anthropicContextTokens(config.model),
      jsonMode: false,
    };
  }

  private body(req: ChatRequest, stream: boolean): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: req.maxOutputTokens ?? this.maxOutputTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: toApiMessages(req.messages),
      ...(req.tools?.length
        ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema })) }
        : {}),
      ...(stream ? { stream: true } : {}),
    };
  }

  private post(req: ChatRequest, stream: boolean): Promise<Response> {
    return postJson(
      'anthropic',
      this.url,
      { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      this.body(req, stream),
      req.signal,
    );
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const res = await this.post(req, false);
    return toResult(this.model, (await res.json()) as ApiMessage);
  }

  async *stream(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const res = await this.post(req, true);
    const blocks: Array<Record<string, unknown>> = [];
    const partialJson: string[] = [];
    const msg: ApiMessage = { content: [], stop_reason: null, usage: {} };

    for await (const ev of readSse(res)) {
      const data = parseEvent<Record<string, any>>('anthropic', ev.data); // eslint-disable-line @typescript-eslint/no-explicit-any
      switch (data.type) {
        case 'message_start':
          msg.usage = { ...data.message?.usage };
          msg.model = data.message?.model;
          break;
        case 'content_block_start': {
          const block = { ...data.content_block };
          if (block.type === 'tool_use') {
            block.input = {};
          }
          blocks[data.index] = block;
          partialJson[data.index] = '';
          break;
        }
        case 'content_block_delta': {
          const block = blocks[data.index];
          const delta = data.delta ?? {};
          if (!block) {
            break;
          }
          if (delta.type === 'text_delta') {
            block.text = `${block.text ?? ''}${delta.text}`;
            yield { type: 'text', delta: delta.text };
          } else if (delta.type === 'input_json_delta') {
            partialJson[data.index] += delta.partial_json ?? '';
          } else if (delta.type === 'thinking_delta') {
            block.thinking = `${block.thinking ?? ''}${delta.thinking}`;
          } else if (delta.type === 'signature_delta') {
            block.signature = delta.signature;
          }
          break;
        }
        case 'content_block_stop': {
          const block = blocks[data.index];
          if (block?.type === 'tool_use') {
            block.input = parseArguments('anthropic', partialJson[data.index]);
            yield { type: 'tool_call', id: block.id as string, name: block.name as string, arguments: block.input as Record<string, unknown> };
          }
          break;
        }
        case 'message_delta':
          msg.stop_reason = data.delta?.stop_reason ?? msg.stop_reason;
          msg.usage = { ...msg.usage, ...data.usage };
          break;
        case 'error':
          throw new ProviderError('anthropic', data.error?.message ?? 'stream error');
      }
    }
    msg.content = blocks.filter(Boolean) as Block[];
    const result = toResult(this.model, msg);
    yield { type: 'done', usage: result.usage, stopReason: result.stopReason, result };
  }
}
