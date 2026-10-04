import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export interface ToolConfig<Args extends ZodRawShapeCompat | undefined> {
  title: string;
  description: string;
  inputSchema?: Args;
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

// ── Untrusted data ─────────────────────────────────────────────────

const UNTRUSTED_TAG = 'untrusted-data';

/**
 * Wraps text that came from Homebridge (log lines, changelogs, accessory and
 * plugin names) in `<untrusted-data source="…">` delimiters so a model can
 * tell data from instructions (the system prompt says never to follow
 * instructions inside them). Any delimiter inside `text` is defused, so the
 * data can't close the block early. Already-wrapped text is returned as is.
 */
export function untrusted(source: string, text: string): string {
  if (isUntrustedBlock(text)) {
    return text;
  }
  const body = text.replace(new RegExp(`<(/?${UNTRUSTED_TAG})`, 'gi'), '&lt;$1');
  return `<${UNTRUSTED_TAG} source="${source.replace(/[^\w.:/-]/g, '_')}">\n${body}\n</${UNTRUSTED_TAG}>`;
}

function isUntrustedBlock(text: string): boolean {
  const close = `</${UNTRUSTED_TAG}>`;
  const single = text.indexOf(close) === text.length - close.length && text.indexOf(`<${UNTRUSTED_TAG}`, 1) === -1;
  return single && text.startsWith(`<${UNTRUSTED_TAG} `) && text.endsWith(close);
}

/** A text result holding Homebridge-sourced free text, wrapped with {@link untrusted}. */
export function untrustedResult(source: string, text: string): CallToolResult {
  return textResult(untrusted(source, text));
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
