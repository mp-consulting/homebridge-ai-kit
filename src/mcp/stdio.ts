import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HomebridgeClient } from './homebridge-client.js';
import { createServer, envFlag } from './create-server.js';
import { runHttpServer } from './http.js';
import type { HttpServerOptions } from './http.js';
import { createAuditLog } from './audit.js';
import type { AuditLog } from './audit.js';
import type { ClientToken } from './scopes.js';
import { isScope } from './scopes.js';

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

/** `HOMEBRIDGE_AI_MCP_TOKENS`: comma-separated `scope:token` pairs, e.g. `read:abc,control:def`. */
export function parseClientTokens(value: string | undefined): ClientToken[] {
  return envList(value).map((entry, i) => {
    const colon = entry.indexOf(':');
    const scope = entry.slice(0, colon);
    const token = entry.slice(colon + 1);
    if (colon < 0 || !isScope(scope) || !token) {
      throw new Error(`HOMEBRIDGE_AI_MCP_TOKENS entry ${i + 1} must look like read:<token>, control:<token> or admin:<token>`);
    }
    return { scope, token, name: `${scope}-${i + 1}` };
  });
}

type HttpEnvOptions = Omit<HttpServerOptions, 'client' | 'port' | 'host' | 'readOnly' | 'allowSecrets' | 'audit'>;

/** The HTTP transport's settings from HOMEBRIDGE_AI_MCP_* env vars (everything but the client and port/host). */
export function httpOptionsFromEnv(env: Env = process.env): HttpEnvOptions {
  const token = env.HOMEBRIDGE_AI_MCP_TOKEN?.trim() ?? '';
  const options: HttpEnvOptions = { token };
  const clients = parseClientTokens(env.HOMEBRIDGE_AI_MCP_TOKENS);
  if (clients.length) {
    options.clients = clients;
  }
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

interface EnvServerOptions {
  readOnly: boolean;
  allowSecrets: boolean;
  audit?: AuditLog;
}

/**
 * `readOnly` / `allowSecrets` from HOMEBRIDGE_READ_ONLY / HOMEBRIDGE_ALLOW_SECRETS (secrets never in
 * read-only mode), and an audit log of write tool calls at HOMEBRIDGE_AI_AUDIT_LOG.
 */
export function serverOptionsFromEnv(env: Env = process.env, onAuditError?: (error: Error) => void): EnvServerOptions {
  const readOnly = envFlag(env.HOMEBRIDGE_READ_ONLY);
  const options: EnvServerOptions = { readOnly, allowSecrets: !readOnly && envFlag(env.HOMEBRIDGE_ALLOW_SECRETS) };
  const auditPath = env.HOMEBRIDGE_AI_AUDIT_LOG?.trim();
  if (auditPath) {
    options.audit = createAuditLog({ path: auditPath, onError: onAuditError });
  }
  return options;
}

/** Builds the client from HOMEBRIDGE_* env vars, exiting with a readable message on bad config. */
function clientFromEnv(prog: string): { client: HomebridgeClient } & EnvServerOptions {
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

  const options = serverOptionsFromEnv(process.env, (error) => console.error(`${prog}: audit log: ${error.message}`));
  const { readOnly, allowSecrets } = options;
  if (readOnly) {
    console.error(`${prog}: read-only mode, write tools are disabled`);
  }
  if (allowSecrets) {
    console.error(`${prog}: warning: HOMEBRIDGE_ALLOW_SECRETS is on, get_config can return real credentials`);
  }
  return { client, ...options };
}

/**
 * Starts the MCP server on stdio, configured from HOMEBRIDGE_* env vars.
 * `prog` prefixes every message so users see the command name they actually ran.
 */
export async function runStdioServer(prog: string): Promise<void> {
  // stdout carries the MCP protocol, so every human-facing message goes to stderr.
  const { client, ...options } = clientFromEnv(prog);
  const server = createServer(client, { ...options, principal: 'stdio' });
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
  if (!httpOptions.token && !httpOptions.clients) {
    console.error(`${prog}: HOMEBRIDGE_AI_MCP_TOKEN is required with --http (clients must send it as a bearer token)`);
    process.exit(1);
  }
  const { client, ...options } = clientFromEnv(prog);
  try {
    const running = await runHttpServer({ ...httpOptions, ...options, port, host, client });
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
