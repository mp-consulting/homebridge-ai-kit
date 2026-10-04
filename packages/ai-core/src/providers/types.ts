import type { ProviderName } from '../core/config.js';
import type { TokenUsage } from '../core/usage.js';

export type { TokenUsage };

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | ({ type: 'tool_call' } & ToolCall)
  | { type: 'tool_result'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
  /**
   * The provider's own rendering of an assistant turn (e.g. Claude thinking
   * blocks with signatures, Gemini thought signatures). Sent back verbatim to
   * the provider that produced it; other providers use `content`.
   */
  providerContent?: { provider: ProviderName; content: unknown };
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema of the tool's arguments (an object schema). */
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export type StopReason = 'end' | 'tool_calls' | 'max_tokens' | 'refusal' | 'other';

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  stopReason: StopReason;
  model: string;
  /** The assistant turn to append to `messages` to continue the conversation. */
  message: ChatMessage;
}

export type ChatChunk =
  | { type: 'text'; delta: string }
  | ({ type: 'tool_call' } & ToolCall)
  | { type: 'done'; usage: TokenUsage; stopReason: StopReason; result: ChatResult };

export interface ProviderCapabilities {
  tools: boolean;
  streaming: boolean;
  contextTokens: number;
  jsonMode: boolean;
}

export interface AiProvider {
  readonly name: ProviderName;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  chat(request: ChatRequest): Promise<ChatResult>;
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
}

/** An HTTP or protocol error from a provider. The message never contains the API key. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    message: string,
    readonly status?: number,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
  }
}
