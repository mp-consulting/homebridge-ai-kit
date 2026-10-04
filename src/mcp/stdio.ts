import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HomebridgeClient } from './homebridge-client.js';
import { createServer, envFlag } from './create-server.js';
import { runHttpServer } from './http.js';
import type { HttpServerOptions } from './http.js';

type Env = Record<string, string | undefined>;

/** Comma- or whitespace-separated list. */
export function envList(value: string | undefined): string[] {
  return (value ?? '').split(/[\s,]+/).filter(Boolean);
}

function envPositiveInt(env: Env, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

/** The HTTP transport's settings from HOMEBRIDGE_AI_MCP_* env vars (everything but the client and port/host). */
export function httpOptionsFromEnv(env: Env = process.env): Omit<HttpServerOptions, 'client' | 'port' | 'host'> {
  const token = env.HOMEBRIDGE_AI_MCP_TOKEN?.trim() ?? '';
  const options: Omit<HttpServerOptions, 'client' | 'port' | 'host'> = { token };
  const origins = envList(env.HOMEBRIDGE_AI_MCP_ALLOWED_ORIGINS);
  if (origins.length) {
    options.allowedOrigins = origins;
  }
  const maxSessions = envPositiveInt(env, 'HOMEBRIDGE_AI_MCP_MAX_SESSIONS');
  if (maxSessions) {
    options.maxSessions = maxSessions;
  }
  const idleMinutes = envPositiveInt(env, 'HOMEBRIDGE_AI_MCP_SESSION_IDLE_MINUTES');
  if (idleMinutes) {
    options.sessionIdleMs = idleMinutes * 60_000;
  }
  return options;
}

/** `readOnly` / `allowSecrets` from HOMEBRIDGE_READ_ONLY / HOMEBRIDGE_ALLOW_SECRETS (secrets never in read-only mode). */
export function serverOptionsFromEnv(env: Env = process.env): { readOnly: boolean; allowSecrets: boolean } {
  const readOnly = envFlag(env.HOMEBRIDGE_READ_ONLY);
  return { readOnly, allowSecrets: !readOnly && envFlag(env.HOMEBRIDGE_ALLOW_SECRETS) };
}

/** Builds the client from HOMEBRIDGE_* env vars, exiting with a readable message on bad config. */
function clientFromEnv(prog: string): { client: HomebridgeClient; readOnly: boolean; allowSecrets: boolean } {
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

  const { readOnly, allowSecrets } = serverOptionsFromEnv();
  if (readOnly) {
    console.error(`${prog}: read-only mode, write tools are disabled`);
  }
  if (allowSecrets) {
    console.error(`${prog}: warning: HOMEBRIDGE_ALLOW_SECRETS is on, get_config can return real credentials`);
  }
  return { client, readOnly, allowSecrets };
}

/**
 * Starts the MCP server on stdio, configured from HOMEBRIDGE_* env vars.
 * `prog` prefixes every message so users see the command name they actually ran.
 */
export async function runStdioServer(prog: string): Promise<void> {
  // stdout carries the MCP protocol, so every human-facing message goes to stderr.
  const { client, readOnly, allowSecrets } = clientFromEnv(prog);
  const server = createServer(client, { readOnly, allowSecrets });
  await server.connect(new StdioServerTransport());
}

/** Starts the Streamable HTTP MCP server; the bearer token comes from HOMEBRIDGE_AI_MCP_TOKEN. */
export async function runHttpFromEnv(prog: string, { port, host }: { port?: number; host?: string } = {}): Promise<void> {
  let httpOptions: ReturnType<typeof httpOptionsFromEnv>;
  try {
    httpOptions = httpOptionsFromEnv();
  } catch (error) {
    console.error(`${prog}: ${(error as Error).message}`);
    process.exit(1);
  }
  if (!httpOptions.token) {
    console.error(`${prog}: HOMEBRIDGE_AI_MCP_TOKEN is required with --http (clients must send it as a bearer token)`);
    process.exit(1);
  }
  const { client, readOnly, allowSecrets } = clientFromEnv(prog);
  try {
    const running = await runHttpServer({ ...httpOptions, port, host, client, readOnly, allowSecrets });
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
