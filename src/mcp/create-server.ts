import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomebridgeClient } from './homebridge-client.js';
import type { RegisterTools } from './types.js';
import { createRegistrar } from './tools/helpers.js';
import { register as registerAccessories } from './tools/accessories.js';
import { register as registerHistory } from './tools/history.js';
import { register as registerServer } from './tools/server.js';
import { register as registerConfig } from './tools/config.js';
import { register as registerConfigBackups } from './tools/config-backups.js';
import { register as registerPlugins } from './tools/plugins.js';
import { register as registerSystem } from './tools/system.js';
import { register as registerLogs } from './tools/logs.js';
import { register as registerPluginJobs } from './tools/plugin-jobs.js';
import { register as registerChildBridges } from './tools/child-bridges.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import type { LiveSource } from './live.js';
import { createLiveSource } from './live.js';

// package.json sits two levels above both src/mcp/ and dist/mcp/, and ships in the npm tarball.
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

export const VERSION = version;

const TOOL_GROUPS: RegisterTools[] = [
  registerAccessories,
  registerHistory,
  registerServer,
  registerConfig,
  registerConfigBackups,
  registerPlugins,
  registerSystem,
  registerLogs,
  registerPluginJobs,
  registerChildBridges,
];

export interface ServerOptions {
  /** Register only tools annotated `readOnlyHint: true`. */
  readOnly?: boolean;
  /**
   * Change feed behind `resources/subscribe`. Default: socket.io with polling
   * fallback ({@link createLiveSource}); `false` disables subscriptions.
   */
  live?: LiveSource | false;
}

export function createServer(client: HomebridgeClient, options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'homebridge-ai-kit', version: VERSION });
  const tool = createRegistrar(server, options);
  for (const register of TOOL_GROUPS) {
    register(tool, client);
  }
  registerResources(server, client, options.live ?? createLiveSource(client));
  registerPrompts(server);
  return server;
}

/** Parses a boolean env var: 1/true/yes/on (any case) are true, anything else is false. */
export function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
}
