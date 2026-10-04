/**
 * HTTP client for the Homebridge Config UI REST API.
 * Handles JWT authentication, token refresh, and all API calls.
 */

import type { Accessory, CachedAccessory, ChildBridge, Plugin, PluginJob, Room } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface LogTail {
  /** The last `maxBytes` of the log, decoded as UTF-8. May start mid-line when truncated. */
  text: string;
  truncated: boolean;
}

/**
 * Returns a warning when credentials would cross the network unencrypted, i.e.
 * plain http to something other than a loopback or private-range host.
 */
export function insecureTransportWarning(url: URL): string | null {
  if (url.protocol !== 'http:') {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/i.test(host);
  return local
    ? null
    : `HOMEBRIDGE_URL uses plain http to a non-local host (${url.host}); your Homebridge credentials will be sent unencrypted.`;
}

export interface HomebridgeClientOptions {
  /** Homebridge UI URL. Default: `HOMEBRIDGE_URL`. */
  url?: string;
  /** Default: `HOMEBRIDGE_USERNAME`. Not needed with a token. */
  username?: string;
  /** Default: `HOMEBRIDGE_PASSWORD`. Not needed with a token. */
  password?: string;
  /** A Homebridge UI API token (Glass UI `hbg_…`). Default: `HOMEBRIDGE_TOKEN`. Replaces username/password. */
  token?: string;
  /** Supplies a (short-lived) token per request, e.g. the current user's JWT. Takes precedence over everything else. */
  getToken?: () => Promise<string>;
  /** Per-request timeout. Default: `HOMEBRIDGE_TIMEOUT_MS`, else 30000. */
  timeoutMs?: number;
}

type AuthMode = { kind: 'login'; username: string; password: string } | { kind: 'static'; token: string } | { kind: 'provider'; getToken: () => Promise<string> };

export class HomebridgeClient {
  private readonly baseUrl: string;
  private readonly auth: AuthMode;
  private readonly timeoutMs: number;
  private token: string | null = null;
  /** In-flight login/refresh, shared so concurrent callers don't each log in. */
  private renewal: Promise<void> | null = null;

  constructor(options: HomebridgeClientOptions = {}) {
    const env = process.env;
    const url = options.url ?? env.HOMEBRIDGE_URL;
    const timeout = options.timeoutMs ?? env.HOMEBRIDGE_TIMEOUT_MS;

    if (!url) {
      throw new Error('HOMEBRIDGE_URL environment variable is required');
    }

    if (options.getToken) {
      this.auth = { kind: 'provider', getToken: options.getToken };
    } else if (options.token ?? env.HOMEBRIDGE_TOKEN) {
      this.auth = { kind: 'static', token: (options.token ?? env.HOMEBRIDGE_TOKEN)! };
    } else {
      const username = options.username ?? env.HOMEBRIDGE_USERNAME;
      const password = options.password ?? env.HOMEBRIDGE_PASSWORD;
      if (!username) {
        throw new Error('HOMEBRIDGE_USERNAME environment variable is required (or set HOMEBRIDGE_TOKEN)');
      }
      if (!password) {
        throw new Error('HOMEBRIDGE_PASSWORD environment variable is required (or set HOMEBRIDGE_TOKEN)');
      }
      this.auth = { kind: 'login', username, password };
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`HOMEBRIDGE_URL is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`HOMEBRIDGE_URL must use http or https, got ${parsed.protocol}`);
    }

    this.timeoutMs = timeout !== undefined && timeout !== '' ? Number(timeout) : DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error(`HOMEBRIDGE_TIMEOUT_MS must be a positive number of milliseconds, got ${timeout}`);
    }

    this.baseUrl = url.replace(/\/+$/, '');
  }

  /** The Homebridge UI base URL, without a trailing slash. */
  get url(): string {
    return this.baseUrl;
  }

  /** A warning to surface at startup if the configured URL is unsafe, else null. */
  get transportWarning(): string | null {
    return insecureTransportWarning(new URL(this.baseUrl));
  }

  // ── Transport ───────────────────────────────────────────────────

  /** fetch with a timeout, turning network failures into readable errors. */
  private async send(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`Homebridge did not respond within ${this.timeoutMs}ms (${method} ${path})`, { cause: error });
      }
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
      throw new Error(`Cannot reach Homebridge at ${this.baseUrl} (${method} ${path})${cause}`, { cause: error });
    }
  }

  // ── Authentication ──────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    if (this.auth.kind === 'static') {
      this.token = this.auth.token;
      return;
    }
    if (this.auth.kind === 'provider') {
      this.token = await this.auth.getToken();
      return;
    }
    const res = await this.send('POST', '/api/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.auth.username, password: this.auth.password }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Authentication failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { access_token: string };
    this.token = data.access_token;
  }

  private async refreshToken(): Promise<boolean> {
    // API tokens cannot be refreshed; a token provider is simply asked again.
    if (!this.token || this.auth.kind !== 'login') {
      return false;
    }

    try {
      const res = await this.send('POST', '/api/auth/refresh', {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
      });

      if (!res.ok) {
        return false;
      }

      const data = (await res.json()) as { access_token: string };
      this.token = data.access_token;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Replace `stale` with a fresh token (refresh, falling back to a full login).
   * Concurrent callers share one renewal, and a caller whose stale token was
   * already replaced by someone else returns immediately.
   */
  private async renewToken(stale: string | null): Promise<void> {
    if (this.token !== stale) {
      return;
    }
    this.renewal ??= (async () => {
      if (!(await this.refreshToken())) {
        await this.authenticate();
      }
    })().finally(() => {
      this.renewal = null;
    });
    await this.renewal;
  }

  // ── Generic request methods ─────────────────────────────────────

  /** A token for the current credentials (logging in if needed), e.g. for a socket.io handshake. */
  async accessToken(): Promise<string> {
    if (this.auth.kind === 'provider') {
      return this.auth.getToken();
    }
    if (!this.token) {
      await this.renewToken(null);
    }
    return this.token!;
  }

  /** Authenticated request returning the raw response; throws on a non-2xx status. */
  private async fetchAuthed(method: string, path: string, body?: unknown): Promise<Response> {
    if (this.auth.kind === 'provider') {
      // Ask for a token on every request: the provider owns caching and expiry.
      this.token = await this.auth.getToken();
    } else if (!this.token) {
      await this.renewToken(null);
    }

    const doFetch = (): Promise<Response> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
      };

      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      return this.send(method, path, {
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    };

    const usedToken = this.token;
    let res = await doFetch();

    // On 401, renew the token (refresh, else re-login) and retry once
    if (res.status === 401 && this.auth.kind !== 'static') {
      await res.body?.cancel();
      await this.renewToken(usedToken);
      res = await doFetch();
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Homebridge API error ${res.status} ${method} ${path}: ${text}`);
    }

    return res;
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchAuthed(method, path, body);

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return (await res.json()) as T;
    }

    return (await res.text()) as unknown as T;
  }

  // ── Accessories ─────────────────────────────────────────────────

  async getAccessories(): Promise<Accessory[]> {
    return this.request<Accessory[]>('GET', '/api/accessories');
  }

  async getAccessory(uniqueId: string): Promise<Accessory> {
    return this.request<Accessory>('GET', `/api/accessories/${encodeURIComponent(uniqueId)}`);
  }

  async getAccessoryLayout(): Promise<Room[]> {
    return this.request<Room[]>('GET', '/api/accessories/layout');
  }

  async setAccessoryCharacteristic(
    uniqueId: string,
    characteristicType: string,
    value: string | number | boolean,
  ): Promise<unknown> {
    return this.request('PUT', `/api/accessories/${encodeURIComponent(uniqueId)}`, {
      characteristicType,
      value,
    });
  }

  // ── Server / Status ─────────────────────────────────────────────

  async getHomebridgeStatus(): Promise<unknown> {
    return this.request('GET', '/api/status/homebridge');
  }

  async getServerInformation(): Promise<unknown> {
    return this.request('GET', '/api/status/server-information');
  }

  async restartServer(): Promise<unknown> {
    return this.request('PUT', '/api/server/restart');
  }

  async getPairingInfo(): Promise<unknown> {
    return this.request('GET', '/api/server/pairing');
  }

  async getCachedAccessories(): Promise<CachedAccessory[]> {
    return this.request<CachedAccessory[]>('GET', '/api/server/cached-accessories');
  }

  /**
   * @param cacheFile Which cache holds the accessory (`$cacheFile` from the list). Omit for the
   *   main bridge; child-bridge accessories live in their own file and can't be removed without it.
   */
  async removeCachedAccessory(uuid: string, cacheFile?: string): Promise<unknown> {
    const query = cacheFile ? `?cacheFile=${encodeURIComponent(cacheFile)}` : '';
    return this.request('DELETE', `/api/server/cached-accessories/${encodeURIComponent(uuid)}${query}`);
  }

  async resetCachedAccessories(): Promise<unknown> {
    return this.request('PUT', '/api/server/reset-cached-accessories');
  }

  // ── Config ──────────────────────────────────────────────────────

  async getConfig(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/api/config-editor');
  }

  async updateConfig(config: unknown): Promise<unknown> {
    return this.request('POST', '/api/config-editor', config);
  }

  // ── Plugins ─────────────────────────────────────────────────────

  async getPlugins(): Promise<Plugin[]> {
    return this.request<Plugin[]>('GET', '/api/plugins');
  }

  async searchPlugins(query: string): Promise<Plugin[]> {
    return this.request<Plugin[]>('GET', `/api/plugins/search/${encodeURIComponent(query)}`);
  }

  async lookupPlugin(pluginName: string): Promise<unknown> {
    return this.request('GET', `/api/plugins/lookup/${encodeURIComponent(pluginName)}`);
  }

  async getPluginVersions(pluginName: string): Promise<unknown> {
    return this.request('GET', `/api/plugins/lookup/${encodeURIComponent(pluginName)}/versions`);
  }

  async getPluginConfigSchema(pluginName: string): Promise<unknown> {
    return this.request('GET', `/api/plugins/config-schema/${encodeURIComponent(pluginName)}`);
  }

  async getPluginChangelog(pluginName: string): Promise<unknown> {
    return this.request('GET', `/api/plugins/changelog/${encodeURIComponent(pluginName)}`);
  }

  /** Starts an install job (Glass UI). */
  async installPlugin(name: string, version?: string): Promise<{ jobId: string }> {
    return this.request('POST', '/api/plugins/install', { name, ...(version ? { version } : {}) });
  }

  async updatePlugin(name: string, version?: string): Promise<{ jobId: string }> {
    return this.request('POST', '/api/plugins/update', { name, ...(version ? { version } : {}) });
  }

  async uninstallPlugin(name: string): Promise<{ jobId: string }> {
    return this.request('POST', '/api/plugins/uninstall', { name });
  }

  async getPluginJob(jobId: string): Promise<PluginJob> {
    return this.request<PluginJob>('GET', `/api/plugins/jobs/${encodeURIComponent(jobId)}`);
  }

  // ── Child bridges ───────────────────────────────────────────────

  async getChildBridges(): Promise<ChildBridge[]> {
    return this.request<ChildBridge[]>('GET', '/api/status/homebridge/child-bridges');
  }

  /** @param deviceId The child bridge's username (`0E:3C:…` or without colons). */
  async controlChildBridge(action: 'restart' | 'stop' | 'start', deviceId: string): Promise<unknown> {
    return this.request('PUT', `/api/server/${action}/${encodeURIComponent(deviceId)}`);
  }

  // ── Platform Tools ──────────────────────────────────────────────

  async getSystemInfo(): Promise<unknown> {
    return this.request('GET', '/api/platform-tools/system-information');
  }

  // ── Logs ────────────────────────────────────────────────────────

  /**
   * Stream the Homebridge log file and keep only its last `maxBytes`, so a
   * multi-hundred-MB log never has to sit in memory whole. The UI strips ANSI
   * colour codes unless `colour=yes` is passed. Requires an hb-service install.
   */
  async getLogTail(maxBytes: number): Promise<LogTail> {
    const res = await this.fetchAuthed('GET', '/api/platform-tools/hb-service/log/download');
    if (!res.body) {
      return { text: '', truncated: false };
    }

    const chunks: Uint8Array[] = [];
    let kept = 0;
    let total = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk);
      kept += chunk.byteLength;
      total += chunk.byteLength;
      // Drop whole leading chunks that are no longer needed to cover maxBytes.
      while (chunks.length > 1 && kept - chunks[0].byteLength >= maxBytes) {
        kept -= chunks.shift()!.byteLength;
      }
    }

    const buffer = Buffer.concat(chunks);
    const tail = buffer.byteLength > maxBytes ? buffer.subarray(buffer.byteLength - maxBytes) : buffer;
    return { text: tail.toString('utf8'), truncated: total > maxBytes };
  }
}
