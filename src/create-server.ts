import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomebridgeClient } from './homebridge-client.js';
import type { RegisterTools } from './types.js';
import { createRegistrar } from './tools/helpers.js';
import { register as registerAccessories } from './tools/accessories.js';
import { register as registerServer } from './tools/server.js';
import { register as registerConfig } from './tools/config.js';
import { register as registerPlugins } from './tools/plugins.js';
import { register as registerSystem } from './tools/system.js';
import { register as registerLogs } from './tools/logs.js';

// package.json sits one level above both src/ and dist/, and ships in the npm tarball.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export const VERSION = version;

const TOOL_GROUPS: RegisterTools[] = [
  registerAccessories,
  registerServer,
  registerConfig,
  registerPlugins,
  registerSystem,
  registerLogs,
];

export interface ServerOptions {
  /** Register only tools annotated `readOnlyHint: true`. */
  readOnly?: boolean;
}

export function createServer(client: HomebridgeClient, options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'homebridge-mcp-server', version: VERSION });
  const tool = createRegistrar(server, options);
  for (const register of TOOL_GROUPS) {
    register(tool, client);
  }
  return server;
}

/** Parses a boolean env var: 1/true/yes/on (any case) are true, anything else is false. */
export function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
}
