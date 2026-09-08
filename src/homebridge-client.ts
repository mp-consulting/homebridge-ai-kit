/**
 * HTTP client for the Homebridge Config UI REST API.
 * Handles JWT authentication, token refresh, and all API calls.
 */

export class HomebridgeClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private token: string | null = null;

  constructor() {
    const url = process.env.HOMEBRIDGE_URL;
    const username = process.env.HOMEBRIDGE_USERNAME;
    const password = process.env.HOMEBRIDGE_PASSWORD;

    if (!url) {
      throw new Error('HOMEBRIDGE_URL environment variable is required');
    }
    if (!username) {
      throw new Error('HOMEBRIDGE_USERNAME environment variable is required');
    }
    if (!password) {
      throw new Error('HOMEBRIDGE_PASSWORD environment variable is required');
    }

    this.baseUrl = url.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
  }

  // ── Authentication ──────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Authentication failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { access_token: string };
    this.token = data.access_token;
  }

  private async refreshToken(): Promise<boolean> {
    if (!this.token) {
      return false;
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/auth/refresh`, {
        method: 'POST',
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

  private async ensureAuthenticated(): Promise<void> {
    if (!this.token) {
      await this.authenticate();
    }
  }

  // ── Generic request method ──────────────────────────────────────

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    await this.ensureAuthenticated();

    const doFetch = async (): Promise<Response> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
      };

      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      return fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    };

    let res = await doFetch();

    // On 401, try refreshing the token, then re-authenticate as fallback
    if (res.status === 401) {
      const refreshed = await this.refreshToken();
      if (!refreshed) {
        await this.authenticate();
      }
      res = await doFetch();
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Homebridge API error ${res.status} ${method} ${path}: ${text}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return (await res.json()) as T;
    }

    return (await res.text()) as unknown as T;
  }

  // ── Accessories ─────────────────────────────────────────────────

  async getAccessories(): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/api/accessories');
  }

  async getAccessoryLayout(): Promise<unknown> {
    return this.request('GET', '/api/accessories/layout');
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

  async getCachedAccessories(): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/api/server/cached-accessories');
  }

  async removeCachedAccessory(uuid: string): Promise<unknown> {
    return this.request('DELETE', `/api/server/cached-accessories/${encodeURIComponent(uuid)}`);
  }

  async resetCachedAccessories(): Promise<unknown> {
    return this.request('PUT', '/api/server/reset-cached-accessories');
  }

  // ── Config ──────────────────────────────────────────────────────

  async getConfig(): Promise<unknown> {
    return this.request('GET', '/api/config-editor');
  }

  async updateConfig(config: unknown): Promise<unknown> {
    return this.request('POST', '/api/config-editor', config);
  }

  // ── Plugins ─────────────────────────────────────────────────────

  async getPlugins(): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/api/plugins');
  }

  async searchPlugins(query: string): Promise<unknown[]> {
    return this.request<unknown[]>('GET', `/api/plugins/search/${encodeURIComponent(query)}`);
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

  // ── Platform Tools ──────────────────────────────────────────────

  async getSystemInfo(): Promise<unknown> {
    return this.request('GET', '/api/platform-tools/system-information');
  }

  // ── Logs ────────────────────────────────────────────────────────

  /**
   * Download the Homebridge log file as plain text. The UI strips ANSI colour
   * codes for us unless `colour=yes` is passed. Requires an hb-service install.
   */
  async getLogFile(): Promise<string> {
    return this.request<string>('GET', '/api/platform-tools/hb-service/log/download');
  }
}
