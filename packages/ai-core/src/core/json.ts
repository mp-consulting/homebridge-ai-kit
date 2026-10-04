/** Schema-checked JSON output: ask, validate with ajv, and give the model one chance to repair. */

import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';
import { complete } from '../providers/index.js';
import type { AiProvider, ChatMessage } from '../providers/types.js';
import { PROMPTS } from './prompts.js';
import type { TokenUsage } from './usage.js';
import { addUsage } from './usage.js';

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

export class JsonGenerationError extends Error {
  constructor(
    message: string,
    readonly text: string,
    readonly errors: string[],
  ) {
    super(message);
    this.name = 'JsonGenerationError';
  }
}

export interface GenerateJsonOptions {
  provider: AiProvider;
  /** JSON Schema the reply must satisfy. */
  schema: Record<string, unknown>;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Receives the raw reply as it streams. */
  onChunk?: (delta: string) => void;
}

export interface GenerateJsonResult<T> {
  data: T;
  text: string;
  usage: TokenUsage;
}

/** The JSON value in a model reply, tolerating code fences and prose around it. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (start === -1 || end <= start) {
      throw new Error('the reply contains no JSON');
    }
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch (error) {
      throw new Error(`the reply is not valid JSON (${(error as Error).message})`, { cause: error });
    }
  }
}

function describe(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`);
}

/** Ask for JSON matching `schema`; on a parse or validation failure, ask once more with the errors. */
export async function generateJson<T = unknown>(options: GenerateJsonOptions): Promise<GenerateJsonResult<T>> {
  const { provider, schema, prompt, signal, onChunk } = options;
  const validate = ajv.compile(schema);
  const system = `${options.system ?? PROMPTS.base}\nReply with JSON only (no prose, no code fences) matching this JSON Schema:\n${JSON.stringify(schema)}`;
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let errors: string[] = [];
  let text = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await complete(provider, { system, messages, maxOutputTokens: options.maxOutputTokens, signal }, onChunk);
    usage = addUsage(usage, result.usage);
    text = result.text;
    try {
      const data = extractJson(text);
      if (validate(data)) {
        return { data: data as T, text, usage };
      }
      errors = describe(validate.errors);
    } catch (error) {
      errors = [(error as Error).message];
    }
    messages.push({ role: 'assistant', content: text || '(empty reply)' }, { role: 'user', content: PROMPTS.repairJson(errors.join('; ')) });
  }
  throw new JsonGenerationError(`The model did not return valid JSON: ${errors.join('; ')}`, text, errors);
}

const DROP_KEYS = new Set(['$schema', 'condition', 'placeholder', 'x-collapsible', 'functionBody', 'layout', 'form', 'display']);

/**
 * Turn a Homebridge `config.schema.json` `schema` (which allows `required: true`
 * on a property, and UI-only keys) into standard JSON Schema for ajv.
 */
export function normalizePluginSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(normalizePluginSchema);
  }
  if (typeof schema !== 'object' || schema === null) {
    return schema;
  }
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (DROP_KEYS.has(key) || (key === 'required' && !Array.isArray(value))) {
      continue;
    }
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      const props = value as Record<string, unknown>;
      out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, normalizePluginSchema(v)]));
      const required = new Set(Array.isArray(src.required) ? (src.required as string[]) : []);
      for (const [k, v] of Object.entries(props)) {
        if (typeof v === 'object' && v !== null && (v as Record<string, unknown>).required === true) {
          required.add(k);
        }
      }
      if (required.size > 0) {
        out.required = [...required];
      }
    } else if (key !== 'required') {
      out[key] = normalizePluginSchema(value);
    } else if (out.required === undefined) {
      out.required = value;
    }
  }
  return out;
}
