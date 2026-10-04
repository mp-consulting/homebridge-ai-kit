import { vi } from 'vitest';
import type { HomebridgeClient } from '../../src/mcp/homebridge-client.js';
import type { RegisterTools } from '../../src/mcp/types.js';
import type { ToolConfig, ToolRegistrar } from '../../src/mcp/tools/helpers.js';

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export type ToolHandler = (args?: Record<string, unknown>) => Promise<ToolResult>;

export interface CollectedTool {
  config: ToolConfig<never>;
  handler: ToolHandler;
}

const CLIENT_METHODS = [
  'getAccessories',
  'getAccessory',
  'getAccessoryLayout',
  'setAccessoryCharacteristic',
  'getHomebridgeStatus',
  'getServerInformation',
  'restartServer',
  'getPairingInfo',
  'getCachedAccessories',
  'removeCachedAccessory',
  'resetCachedAccessories',
  'getConfig',
  'updateConfig',
  'getPlugins',
  'searchPlugins',
  'lookupPlugin',
  'getPluginVersions',
  'getPluginConfigSchema',
  'getPluginChangelog',
  'getSystemInfo',
  'getLogTail',
] as const satisfies ReadonlyArray<keyof HomebridgeClient>;

/** A HomebridgeClient whose every method is a `vi.fn()`, with optional overrides. */
export function mockClient(overrides: Partial<Record<(typeof CLIENT_METHODS)[number], unknown>> = {}): HomebridgeClient {
  const client: Record<string, unknown> = {};
  for (const method of CLIENT_METHODS) {
    client[method] = vi.fn();
  }
  return { ...client, ...overrides } as unknown as HomebridgeClient;
}

/**
 * Run a tool group's `register` against a recording registrar and return each
 * tool's config and handler by name. Handlers are called directly, so Zod
 * input validation is not applied — test that through `createServer`.
 */
export function collectTools(register: RegisterTools, client: HomebridgeClient): Map<string, CollectedTool> {
  const tools = new Map<string, CollectedTool>();
  const registrar = ((name: string, config: ToolConfig<never>, cb: (args: unknown, extra: unknown) => Promise<ToolResult>) => {
    tools.set(name, { config, handler: (args = {}) => cb(args, {}) });
  }) as unknown as ToolRegistrar;
  register(registrar, client);
  return tools;
}

/** Shorthand: the handlers from {@link collectTools}. */
export function collectHandlers(register: RegisterTools, client: HomebridgeClient): Map<string, ToolHandler> {
  return new Map([...collectTools(register, client)].map(([name, t]) => [name, t.handler]));
}
