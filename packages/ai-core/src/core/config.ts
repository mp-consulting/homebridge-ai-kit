/**
 * The `HomebridgeAiKit` platform block in Homebridge's config.json: which AI
 * provider the Assistant uses, and whether the HTTP MCP server runs.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PLATFORM_NAME = 'HomebridgeAiKit';
export const PLUGIN_NAME = '@mp-consulting/homebridge-ai-kit';

export const PROVIDER_NAMES = ['anthropic', 'openai', 'gemini', 'openai-compatible'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Claude `output_config.effort` levels: how much the model thinks and spends per answer. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-5',
  gemini: 'gemini-3.8-flash',
  'openai-compatible': 'llama3.1',
};

export const DEFAULT_BASE_URLS: Record<ProviderName, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  'openai-compatible': 'http://127.0.0.1:11434/v1',
};

export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const DEFAULT_MCP_HTTP_PORT = 8582;
export const DEFAULT_MCP_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HOMEBRIDGE_URL = 'http://127.0.0.1:8581';

/** Scopes an MCP client token can have: `read` < `control` (device control) < `admin` (everything). */
const MCP_SCOPES = ['read', 'control', 'admin'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** An extra bearer token for the HTTP MCP server, with its own scope. */
export interface McpClientConfig {
  /** Shown in the audit log. */
  name?: string;
  /** Secret. */
  token: string;
  scope: McpScope;
}

export interface McpHttpConfig {
  enabled: boolean;
  /** Caps every client token at read-only access. */
  readOnly?: boolean;
  /** More client tokens besides `token`, each with a scope. */
  clients?: McpClientConfig[];
  /** Log write tool calls to a JSONL file (default true). */
  auditLog?: boolean;
  /** Where; default `<Homebridge storage>/homebridge-ai-kit-audit.jsonl`. */
  auditLogPath?: string;
  host: string;
  port: number;
  /** Bearer token MCP clients must send. Secret. */
  token?: string;
  /** Homebridge UI the MCP tools talk to (default http://127.0.0.1:8581). */
  homebridgeUrl?: string;
  /** Homebridge UI API token the MCP tools use (Glass UI `hbg_…`). Secret. */
  homebridgeToken?: string;
  /** SHA-256 fingerprint of an https Homebridge UI's (self-signed) certificate to trust, pinned. */
  homebridgeCertFingerprint?: string;
  /** PEM file with the https Homebridge UI's own certificate or its CA, to trust. */
  homebridgeCertPath?: string;
  /** Browser origins allowed to call the MCP server besides loopback and its own IP address (`*` for any). */
  allowedOrigins?: string[];
}

export interface AiConfig {
  platform: typeof PLATFORM_NAME;
  name: string;
  enabled: boolean;
  provider: ProviderName;
  model: string;
  /** Secret: redaction treats it as one. */
  apiKey?: string;
  baseUrl?: string;
  maxOutputTokens: number;
  /** Overrides the provider's context window, e.g. for a local model. */
  contextTokens?: number;
  /** Claude only: `output_config.effort`. Unset leaves the model's default (`high`; `medium` on Claude Opus 5.5). Not supported by Claude Haiku 4.5. */
  effort?: EffortLevel;
  /** Retries of a failed provider request (network error, 408, 429, 5xx); default 2, 0 disables. */
  maxRetries?: number;
  mcp: { http: McpHttpConfig };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** A list of non-empty strings from an array or a comma-separated string. */
function strList(v: unknown): string[] | undefined {
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = items.map(str).filter((x): x is string => x !== undefined);
  return out.length ? out : undefined;
}

/** `mcp.http.clients`: rows without a token are skipped (an empty form row); an unknown scope throws. */
function mcpClients(v: unknown): McpClientConfig[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: McpClientConfig[] = [];
  v.forEach((row, i) => {
    const token = isObject(row) ? str(row.token) : undefined;
    if (!isObject(row) || !token) {
      return;
    }
    const scope = str(row.scope) ?? 'read';
    if (!(MCP_SCOPES as readonly string[]).includes(scope)) {
      throw new Error(`mcp.http.clients[${i}].scope must be one of ${MCP_SCOPES.join(', ')}, got ${JSON.stringify(row.scope)}`);
    }
    const name = str(row.name);
    out.push({ ...(name ? { name } : {}), token, scope: scope as McpScope });
  });
  return out.length ? out : undefined;
}

function positiveInt(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === '') {
    return undefined;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(v)}`);
  }
  return n;
}

function nonNegativeInt(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === '') {
    return undefined;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(v)}`);
  }
  return n;
}

/** Applies defaults to a `HomebridgeAiKit` block. Throws on an unknown provider or invalid numbers. */
export function resolveAiConfig(block: unknown = {}): AiConfig {
  const b = isObject(block) ? block : {};
  const providerRaw = str(b.provider) ?? 'anthropic';
  if (!(PROVIDER_NAMES as readonly string[]).includes(providerRaw)) {
    throw new Error(`Unknown AI provider "${providerRaw}". Use one of: ${PROVIDER_NAMES.join(', ')}`);
  }
  const provider = providerRaw as ProviderName;
  const http = isObject(b.mcp) && isObject(b.mcp.http) ? b.mcp.http : {};

  const config: AiConfig = {
    platform: PLATFORM_NAME,
    name: str(b.name) ?? 'AI Kit',
    enabled: b.enabled !== false,
    provider,
    model: str(b.model) ?? DEFAULT_MODELS[provider],
    maxOutputTokens: positiveInt(b.maxOutputTokens, 'maxOutputTokens') ?? DEFAULT_MAX_OUTPUT_TOKENS,
    mcp: {
      http: {
        enabled: http.enabled === true,
        host: str(http.host) ?? DEFAULT_MCP_HTTP_HOST,
        port: positiveInt(http.port, 'mcp.http.port') ?? DEFAULT_MCP_HTTP_PORT,
        readOnly: http.readOnly === true,
        auditLog: http.auditLog !== false,
      },
    },
  };
  const effort = str(b.effort);
  if (effort !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    throw new Error(`Unknown effort "${effort}". Use one of: ${EFFORT_LEVELS.join(', ')}`);
  }
  const optional: Array<[keyof AiConfig, string | number | undefined]> = [
    ['effort', effort],
    ['apiKey', str(b.apiKey)],
    ['baseUrl', str(b.baseUrl)?.replace(/\/+$/, '')],
    ['contextTokens', positiveInt(b.contextTokens, 'contextTokens')],
    ['maxRetries', nonNegativeInt(b.maxRetries, 'maxRetries')],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) {
      (config as unknown as Record<string, unknown>)[key] = value;
    }
  }
  for (const key of ['token', 'homebridgeUrl', 'homebridgeToken', 'homebridgeCertFingerprint', 'homebridgeCertPath'] as const) {
    const value = str(http[key]);
    if (value !== undefined) {
      config.mcp.http[key] = value;
    }
  }
  const allowedOrigins = strList(http.allowedOrigins);
  if (allowedOrigins) {
    config.mcp.http.allowedOrigins = allowedOrigins;
  }
  const clients = mcpClients(http.clients);
  if (clients) {
    config.mcp.http.clients = clients;
  }
  const auditLogPath = str(http.auditLogPath);
  if (auditLogPath) {
    config.mcp.http.auditLogPath = auditLogPath;
  }
  return config;
}

/** Default config.json location: `$UIX_STORAGE_PATH/config.json`, else `~/.homebridge/config.json`. */
export function defaultConfigPath(): string {
  return join(process.env.UIX_STORAGE_PATH || join(homedir(), '.homebridge'), 'config.json');
}

/** The raw `HomebridgeAiKit` block of a parsed config.json, or undefined. */
export function findAiBlock(config: unknown): Record<string, unknown> | undefined {
  if (!isObject(config) || !Array.isArray(config.platforms)) {
    return undefined;
  }
  return config.platforms.find((p): p is Record<string, unknown> => isObject(p) && p.platform === PLATFORM_NAME);
}

/**
 * Reads the `HomebridgeAiKit` block from Homebridge's config.json.
 * @returns null when the file or the block does not exist.
 */
export async function readAiConfig(configPath: string = defaultConfigPath()): Promise<AiConfig | null> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cannot parse ${configPath}: ${(error as Error).message}`, { cause: error });
  }
  const block = findAiBlock(parsed);
  return block ? resolveAiConfig(block) : null;
}
