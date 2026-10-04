import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HomebridgeClient } from './homebridge-client.js';
import { createServer, envFlag } from './create-server.js';

/**
 * Starts the MCP server on stdio, configured from HOMEBRIDGE_* env vars.
 * `prog` prefixes every message so users see the command name they actually ran.
 */
export async function runStdioServer(prog: string): Promise<void> {
  // stdout carries the MCP protocol, so every human-facing message goes to stderr.
  let client: HomebridgeClient;
  try {
    client = new HomebridgeClient();
  } catch (error) {
    console.error(`${prog}: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  if (client.transportWarning) {
    console.error(`${prog}: warning: ${client.transportWarning}`);
  }

  const readOnly = envFlag(process.env.HOMEBRIDGE_READ_ONLY);
  if (readOnly) {
    console.error(`${prog}: read-only mode, write tools are disabled`);
  }

  const server = createServer(client, { readOnly });
  await server.connect(new StdioServerTransport());
}
