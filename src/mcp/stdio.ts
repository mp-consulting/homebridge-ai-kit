import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HomebridgeClient } from './homebridge-client.js';
import { createServer, envFlag } from './create-server.js';
import { runHttpServer } from './http.js';

/** Builds the client from HOMEBRIDGE_* env vars, exiting with a readable message on bad config. */
function clientFromEnv(prog: string): { client: HomebridgeClient; readOnly: boolean } {
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
  return { client, readOnly };
}

/**
 * Starts the MCP server on stdio, configured from HOMEBRIDGE_* env vars.
 * `prog` prefixes every message so users see the command name they actually ran.
 */
export async function runStdioServer(prog: string): Promise<void> {
  // stdout carries the MCP protocol, so every human-facing message goes to stderr.
  const { client, readOnly } = clientFromEnv(prog);
  const server = createServer(client, { readOnly });
  await server.connect(new StdioServerTransport());
}

/** Starts the Streamable HTTP MCP server; the bearer token comes from HOMEBRIDGE_AI_MCP_TOKEN. */
export async function runHttpFromEnv(prog: string, { port, host }: { port?: number; host?: string } = {}): Promise<void> {
  const token = process.env.HOMEBRIDGE_AI_MCP_TOKEN?.trim();
  if (!token) {
    console.error(`${prog}: HOMEBRIDGE_AI_MCP_TOKEN is required with --http (clients must send it as a bearer token)`);
    process.exit(1);
  }
  const { client, readOnly } = clientFromEnv(prog);
  try {
    const running = await runHttpServer({ port, host, token, client, readOnly });
    console.error(`${prog}: MCP over HTTP at ${running.url}`);
    const stop = () => {
      void running.close().then(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error(`${prog}: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
