import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomebridgeClient } from './homebridge-client.js';
import type { RegisterTools } from './types.js';
import { createRegistrar } from './tools/helpers.js';
import { withElicitation } from './elicitation.js';
import { register as registerAccessories } from './tools/accessories.js';
import { register as registerHistory } from './tools/history.js';
import { register as registerBulk } from './tools/bulk.js';
import { register as registerServer } from './tools/server.js';
import { register as registerConfig } from './tools/config.js';
import { register as registerConfigBackups } from './tools/config-backups.js';
import { register as registerPlugins } from './tools/plugins.js';
import { register as registerSystem } from './tools/system.js';
import { register as registerLogs } from './tools/logs.js';
import { register as registerPluginJobs } from './tools/plugin-jobs.js';
import { register as registerChildBridges } from './tools/child-bridges.js';
import { register as registerScenes } from './tools/scenes.js';
import { register as registerNotifications } from './tools/notifications.js';
import { registerResources } from './resources.js';
import { registerResourceTemplates } from './resource-templates.js';
import { registerPrompts } from './prompts.js';
import type { LiveSource } from './live.js';
import { createLiveSource } from './live.js';

// package.json sits two levels above both src/mcp/ and dist/mcp/, and ships in the npm tarball.
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

export const VERSION = version;

const TOOL_GROUPS: RegisterTools[] = [
  registerAccessories,
  registerHistory,
  registerBulk,
  registerServer,
  registerConfig,
  registerConfigBackups,
  registerPlugins,
  registerSystem,
  registerLogs,
  registerPluginJobs,
  registerChildBridges,
  registerScenes,
  registerNotifications,
];

export interface ServerOptions {
  /** Register only tools annotated `readOnlyHint: true`. */
  readOnly?: boolean;
  /**
   * Change feed behind `resources/subscribe`. Default: socket.io with polling
   * fallback ({@link createLiveSource}); `false` disables subscriptions.
   */
  live?: LiveSource | false;
  /**
   * Ask the user to confirm destructive tools through MCP elicitation when the client supports it.
   * Default: on, unless `HOMEBRIDGE_ELICITATION` is 0/false/no/off.
   */
  elicitation?: boolean;
}

export function createServer(client: HomebridgeClient, options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'homebridge-ai-kit', version: VERSION });
  const elicitation = options.elicitation ?? !/^(0|false|no|off)$/i.test(process.env.HOMEBRIDGE_ELICITATION?.trim() ?? '');
  const registrar = createRegistrar(server, options);
  const tool = elicitation ? withElicitation(registrar, server) : registrar;
  for (const register of TOOL_GROUPS) {
    register(tool, client);
  }
  registerResources(server, client, options.live ?? createLiveSource(client));
  registerResourceTemplates(server, client);
  registerPrompts(server);
  return server;
}

/** Parses a boolean env var: 1/true/yes/on (any case) are true, anything else is false. */
export function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
}
