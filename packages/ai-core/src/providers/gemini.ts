/** Google Gemini via `generateContent` / `streamGenerateContent`, plain fetch. */

import type { AiConfig } from '../core/config.js';
import { DEFAULT_BASE_URLS, DEFAULT_MAX_OUTPUT_TOKENS } from '../core/config.js';
import { parseEvent, partsOf, postJson, readSse } from './http.js';
import type { AiProvider, ChatChunk, ChatMessage, ChatRequest, ChatResult, ProviderCapabilities, StopReason, ToolCall } from './types.js';
import { ProviderError } from './types.js';

interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  [key: string]: unknown;
}

interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

interface ApiResponse {
  candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
  error?: { message?: string };
}

const STOP_REASONS: Record<string, StopReason> = {
  STOP: 'end',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'refusal',
  RECITATION: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  BLOCKLIST: 'refusal',
};

/** Schema keywords Gemini's OpenAPI-subset `parameters` accepts. */
const SCHEMA_KEYS = new Set([
  'type', 'format', 'description', 'nullable', 'enum', 'properties', 'required', 'items',
  'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'anyOf', 'title',
]);

/** Reduce a JSON Schema to the subset Gemini function declarations accept. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(toGeminiSchema);
  }
  if (typeof schema !== 'object' || schema === null) {
    return schema;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(key)) {
      continue;
    }
    if (key === 'type' && Array.isArray(value)) {
      const types = value.filter((t) => t !== 'null');
      out.type = types[0] ?? 'string';
      if (types.length < value.length) {
        out.nullable = true;
      }
    } else if (key === 'properties' && typeof value === 'object' && value !== null) {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]));
    } else if (key === 'items' || key === 'anyOf') {
      out[key] = toGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function toContents(messages: ChatMessage[]): Content[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.providerContent?.provider === 'gemini') {
      return { role: 'model', parts: m.providerContent.content as Part[] };
    }
    const parts = partsOf(m).map((p): Part => {
      switch (p.type) {
        case 'text':
          return { text: p.text };
        case 'tool_call':
          return { functionCall: { name: p.name, args: p.arguments } };
        case 'tool_result':
          return { functionResponse: { name: p.name, response: p.isError ? { error: p.content } : { content: p.content } } };
      }
    });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
}

function buildResult(model: string, parts: Part[], finish: string | undefined, meta: ApiResponse['usageMetadata']): ChatResult {
  const text = parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  const toolCalls: ToolCall[] = parts
    .filter((p) => p.functionCall)
    .map((p, i) => ({ id: p.functionCall!.id ?? `call_${i}`, name: p.functionCall!.name, arguments: p.functionCall!.args ?? {} }));
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: meta?.promptTokenCount ?? 0,
      outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
    },
    stopReason: toolCalls.length > 0 ? 'tool_calls' : (STOP_REASONS[finish ?? ''] ?? 'other'),
    model,
    message: {
      role: 'assistant',
      content: [...(text ? [{ type: 'text' as const, text }] : []), ...toolCalls.map((c) => ({ type: 'tool_call' as const, ...c }))],
      providerContent: { provider: 'gemini', content: parts },
    },
  };
}

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxOutputTokens: number;

  constructor(config: Pick<AiConfig, 'model' | 'apiKey' | 'baseUrl' | 'maxOutputTokens' | 'contextTokens'>) {
    if (!config.apiKey) {
      throw new ProviderError('gemini', 'an API key is required');
    }
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URLS.gemini;
    this.maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.capabilities = { tools: true, streaming: true, contextTokens: config.contextTokens ?? 1_048_576, jsonMode: true };
  }

  private post(req: ChatRequest, stream: boolean): Promise<Response> {
    const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const body = {
      contents: toContents(req.messages),
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      ...(req.tools?.length
        ? {
          tools: [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description ?? '',
                parameters: toGeminiSchema(t.inputSchema),
              })),
            },
          ],
        }
        : {}),
      generationConfig: { maxOutputTokens: req.maxOutputTokens ?? this.maxOutputTokens },
    };
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:${method}`;
    return postJson('gemini', url, { 'x-goog-api-key': this.apiKey }, body, req.signal);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const res = await this.post(req, false);
    const data = (await res.json()) as ApiResponse;
    const candidate = data.candidates?.[0];
    return buildResult(data.modelVersion ?? this.model, candidate?.content?.parts ?? [], candidate?.finishReason, data.usageMetadata);
  }

  async *stream(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const res = await this.post(req, true);
    const parts: Part[] = [];
    let finish: string | undefined;
    let meta: ApiResponse['usageMetadata'];
    let model = this.model;
    let calls = 0;

    for await (const ev of readSse(res)) {
      const data = parseEvent<ApiResponse>('gemini', ev.data);
      if (data.error) {
        throw new ProviderError('gemini', data.error.message ?? 'stream error');
      }
      model = data.modelVersion ?? model;
      meta = data.usageMetadata ?? meta;
      const candidate = data.candidates?.[0];
      finish = candidate?.finishReason ?? finish;
      for (const part of candidate?.content?.parts ?? []) {
        parts.push(part);
        if (typeof part.text === 'string' && part.text !== '' && !part.thought) {
          yield { type: 'text', delta: part.text };
        }
        if (part.functionCall) {
          const id = part.functionCall.id ?? `call_${calls}`;
          calls++;
          yield { type: 'tool_call', id, name: part.functionCall.name, arguments: part.functionCall.args ?? {} };
        }
      }
    }
    const result = buildResult(model, parts, finish, meta);
    yield { type: 'done', usage: result.usage, stopReason: result.stopReason, result };
  }
}
