#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HomebridgeClient } from './homebridge-client.js';
import { register as registerAccessories } from './tools/accessories.js';
import { register as registerServer } from './tools/server.js';
import { register as registerConfig } from './tools/config.js';
import { register as registerPlugins } from './tools/plugins.js';
import { register as registerSystem } from './tools/system.js';
import { register as registerLogs } from './tools/logs.js';

const server = new McpServer({
  name: 'homebridge-mcp-server',
  version: '1.0.1',
});

const client = new HomebridgeClient();

// Register all tool groups
registerAccessories(server, client);
registerServer(server, client);
registerConfig(server, client);
registerPlugins(server, client);
registerSystem(server, client);
registerLogs(server, client);

// Start the server with stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
