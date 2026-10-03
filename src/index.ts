#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HomebridgeClient } from './homebridge-client.js';
import { createServer, envFlag } from './create-server.js';

// stdout carries the MCP protocol, so every human-facing message goes to stderr.
let client: HomebridgeClient;
try {
  client = new HomebridgeClient();
} catch (error) {
  console.error(`homebridge-mcp-server: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

if (client.transportWarning) {
  console.error(`homebridge-mcp-server: warning: ${client.transportWarning}`);
}

const readOnly = envFlag(process.env.HOMEBRIDGE_READ_ONLY);
if (readOnly) {
  console.error('homebridge-mcp-server: read-only mode, write tools are disabled');
}

const server = createServer(client, { readOnly });
await server.connect(new StdioServerTransport());
