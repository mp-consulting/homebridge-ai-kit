/**
 * The `HomebridgeAiKit` platform. It exposes no accessories: it reports the
 * Assistant's configuration and, when enabled, serves MCP over HTTP so
 * outside clients (Claude Desktop, Claude Code, Cursor) can reach Homebridge.
 */

import type { AiConfig } from '@mp-consulting/homebridge-ai-core';
import { DEFAULT_HOMEBRIDGE_URL, createProvider, resolveAiConfig } from '@mp-consulting/homebridge-ai-core';
import { HomebridgeClient } from '../mcp/homebridge-client.js';
import type { RunningHttpServer } from '../mcp/http.js';
import { runHttpServer } from '../mcp/http.js';
import { createAuditLog, defaultAuditLogPath } from '../mcp/audit.js';

/** The slice of Homebridge's logger, config and API the platform needs (no runtime dependency on homebridge). */
export interface PlatformLogger {
  info(message: string, ...params: unknown[]): void;
  warn(message: string, ...params: unknown[]): void;
  error(message: string, ...params: unknown[]): void;
}

export interface PlatformApi {
  on(event: 'didFinishLaunching' | 'shutdown', listener: () => void): unknown;
  /** Homebridge's storage directory (where config.json lives). */
  user?: { storagePath(): string };
}

export class AiKitPlatform {
  readonly config: AiConfig | null = null;
  private http: RunningHttpServer | undefined;
  /** Settles once startup work (the HTTP server) is done. */
  ready: Promise<void> = Promise.resolve();

  constructor(
    private readonly log: PlatformLogger,
    rawConfig: unknown,
    private readonly api: PlatformApi,
  ) {
    try {
      this.config = resolveAiConfig(rawConfig);
    } catch (error) {
      log.error(`Invalid configuration: ${(error as Error).message}`);
      return;
    }
    this.logStatus(this.config);
    api.on('didFinishLaunching', () => {
      this.ready = this.startHttp(this.config!);
    });
    api.on('shutdown', () => {
      void this.http?.close();
    });
  }

  /** Homebridge calls this for cached accessories; this platform has none. */
  configureAccessory(): void {}

  private logStatus(config: AiConfig): void {
    if (!config.enabled) {
      this.log.info('Assistant disabled.');
      return;
    }
    try {
      const provider = createProvider(config);
      const { tools, contextTokens } = provider.capabilities;
      this.log.info(`Assistant ready: ${config.provider} / ${config.model} (${tools ? 'tools' : 'no tools'}, ${contextTokens} token context).`);
    } catch (error) {
      this.log.warn(`Assistant not ready: ${(error as Error).message}`);
    }
  }

  private async startHttp(config: AiConfig): Promise<void> {
    const http = config.mcp.http;
    if (!http.enabled) {
      return;
    }
    const token = http.token || process.env.HOMEBRIDGE_AI_MCP_TOKEN;
    if (!token && !http.clients?.length) {
      this.log.error('MCP over HTTP is enabled but has no token. Set one in the AI Kit settings.');
      return;
    }
    let client: HomebridgeClient;
    try {
      const url = http.homebridgeUrl || process.env.HOMEBRIDGE_URL || DEFAULT_HOMEBRIDGE_URL;
      client = new HomebridgeClient({
        url,
        ...(http.homebridgeToken ? { token: http.homebridgeToken } : {}),
        certFingerprint: http.homebridgeCertFingerprint,
        certPath: http.homebridgeCertPath,
      });
    } catch (error) {
      const message = (error as Error).message;
      const hint = /HOMEBRIDGE_(USERNAME|PASSWORD)/.test(message) ? ' Set a Homebridge API token in the AI Kit settings.' : '';
      this.log.error(`MCP over HTTP not started: ${message}.${hint}`);
      return;
    }
    try {
      const audit = http.auditLog === false
        ? undefined
        : createAuditLog({
          path: http.auditLogPath ?? defaultAuditLogPath(this.api.user?.storagePath()),
          onError: (error) => this.log.warn(`MCP audit log: ${error.message}`),
        });
      this.http = await runHttpServer({
        host: http.host,
        port: http.port,
        token,
        clients: http.clients,
        client,
        readOnly: http.readOnly,
        allowedOrigins: http.allowedOrigins,
        audit,
      });
      this.log.info(`MCP server listening at ${this.http.url}${http.readOnly ? ' (read-only)' : ''}`);
      if (audit) {
        this.log.info(`MCP write tool calls are logged to ${audit.path}`);
      }
    } catch (error) {
      this.log.error(`MCP over HTTP not started: ${(error as Error).message}`);
    }
  }
}
