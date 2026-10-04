import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export interface ToolConfig<Args extends ZodRawShapeCompat | undefined> {
  title: string;
  description: string;
  inputSchema?: Args;
  /**
   * Shape of `structuredContent`; a tool that sets it must return {@link structuredResult}.
   * Keep it loose (looseObject, optional fields): the server rejects a result that doesn't match.
   */
  outputSchema?: AnySchema;
  /** Required so every tool states whether it reads or writes. */
  annotations: ToolAnnotations & { readOnlyHint: boolean };
}

/** Registers a tool, or silently skips it when the server runs read-only and the tool writes. */
export type ToolRegistrar = <Args extends ZodRawShapeCompat | undefined = undefined>(
  name: string,
  config: ToolConfig<Args>,
  cb: ToolCallback<Args>,
) => void;

export function createRegistrar(server: McpServer, { readOnly = false }: { readOnly?: boolean } = {}): ToolRegistrar {
  return (name, config, cb) => {
    if (readOnly && !config.annotations.readOnlyHint) {
      return;
    }
    server.registerTool(name, config, cb);
  };
}

// ── Annotation presets ─────────────────────────────────────────────

/** Reads Homebridge state, changes nothing. */
export const READ: ToolConfig<undefined>['annotations'] = { readOnlyHint: true, openWorldHint: false };

/** Reads from the npm registry via Homebridge. */
export const READ_REGISTRY: ToolConfig<undefined>['annotations'] = { readOnlyHint: true, openWorldHint: true };

// ── Results ────────────────────────────────────────────────────────

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Compact JSON: pretty-printing costs ~25% more tokens for the same data. */
export function jsonResult(data: unknown): CallToolResult {
  return textResult(JSON.stringify(data));
}

/**
 * `structuredContent` for clients that read it, plus a text block for those that don't. The text
 * keeps the tool's historical JSON (`text`, by default the structured object itself).
 */
export function structuredResult(structured: Record<string, unknown>, text: unknown = structured): CallToolResult {
  return { ...textResult(JSON.stringify(text)), structuredContent: structured };
}

/** An API answer as a structured object: objects pass through, anything else is wrapped as `{ value }`. */
export function asObject(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : { value: data };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wraps a tool handler so a thrown error becomes an `isError` result prefixed with `action`. */
export function handle<A extends unknown[]>(
  action: string,
  fn: (...args: A) => Promise<CallToolResult>,
): (...args: A) => Promise<CallToolResult> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return errorResult(`Error ${action}: ${errorMessage(error)}`);
    }
  };
}

/** Copies only the listed keys that are present on `obj`. */
export function pick<T extends object, K extends string>(obj: T, keys: readonly K[]): Partial<Record<K, unknown>> {
  const out: Partial<Record<K, unknown>> = {};
  for (const key of keys) {
    if (key in obj) {
      out[key] = (obj as Record<string, unknown>)[key];
    }
  }
  return out;
}
