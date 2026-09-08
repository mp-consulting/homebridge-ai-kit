import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to set env vars before importing the client
const ENV = {
  HOMEBRIDGE_URL: 'http://localhost:8581',
  HOMEBRIDGE_USERNAME: 'admin',
  HOMEBRIDGE_PASSWORD: 'admin',
};

function mockFetch() {
  const fn = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
  vi.stubGlobal('fetch', fn);
  return fn;
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

describe('HomebridgeClient', () => {
  let fetchMock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    Object.assign(process.env, ENV);
    fetchMock = mockFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function createClient() {
    // Dynamic import so each test gets a fresh module with current env
    const mod = await import('../src/homebridge-client.js');
    return new mod.HomebridgeClient();
  }

  // Helper: set up fetch to handle login + one API call
  function setupAuthAndApi(apiResponse: Response) {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok123' })) // login
      .mockResolvedValueOnce(apiResponse);
  }

  // ── Constructor ───────────────────────────────────────────────

  describe('constructor', () => {
    it('throws when HOMEBRIDGE_URL is missing', async () => {
      delete process.env.HOMEBRIDGE_URL;
      await expect(createClient()).rejects.toThrow('HOMEBRIDGE_URL');
    });

    it('throws when HOMEBRIDGE_USERNAME is missing', async () => {
      delete process.env.HOMEBRIDGE_USERNAME;
      await expect(createClient()).rejects.toThrow('HOMEBRIDGE_USERNAME');
    });

    it('throws when HOMEBRIDGE_PASSWORD is missing', async () => {
      delete process.env.HOMEBRIDGE_PASSWORD;
      await expect(createClient()).rejects.toThrow('HOMEBRIDGE_PASSWORD');
    });

    it('strips trailing slashes from URL', async () => {
      process.env.HOMEBRIDGE_URL = 'http://localhost:8581///';
      const client = await createClient();
      setupAuthAndApi(jsonResponse([]));
      await client.getAccessories();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8581/api/auth/login',
        expect.anything(),
      );
    });
  });

  // ── Authentication ────────────────────────────────────────────

  describe('authentication', () => {
    it('authenticates on first request', async () => {
      const client = await createClient();
      setupAuthAndApi(jsonResponse([{ id: 1 }]));

      const result = await client.getAccessories();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      // First call: login
      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8581/api/auth/login');
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      });
      expect(result).toEqual([{ id: 1 }]);
    });

    it('throws on failed authentication', async () => {
      const client = await createClient();
      fetchMock.mockResolvedValueOnce(textResponse('Unauthorized', 401));

      await expect(client.getAccessories()).rejects.toThrow('Authentication failed (401)');
    });

    it('reuses token for subsequent requests', async () => {
      const client = await createClient();
      // First request: login + api
      setupAuthAndApi(jsonResponse({ status: 'ok' }));
      await client.getHomebridgeStatus();

      // Second request: only api (no login)
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
      await client.getHomebridgeStatus();

      // 3 total calls: login + api + api
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  // ── Token refresh / retry on 401 ─────────────────────────────

  describe('401 retry logic', () => {
    it('refreshes token on 401 and retries', async () => {
      const client = await createClient();
      // Initial auth
      fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'tok1' }));
      // API returns 401
      fetchMock.mockResolvedValueOnce(textResponse('Unauthorized', 401));
      // Refresh succeeds
      fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'tok2' }));
      // Retry succeeds
      fetchMock.mockResolvedValueOnce(jsonResponse({ up: true }));

      const result = await client.getHomebridgeStatus();
      expect(result).toEqual({ up: true });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      // Third call should be refresh
      expect(fetchMock.mock.calls[2][0]).toBe('http://localhost:8581/api/auth/refresh');
    });

    it('re-authenticates when refresh fails', async () => {
      const client = await createClient();
      // Initial auth
      fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'tok1' }));
      // API returns 401
      fetchMock.mockResolvedValueOnce(textResponse('Unauthorized', 401));
      // Refresh fails
      fetchMock.mockResolvedValueOnce(textResponse('Forbidden', 403));
      // Re-authenticate
      fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'tok3' }));
      // Retry succeeds
      fetchMock.mockResolvedValueOnce(jsonResponse({ up: true }));

      const result = await client.getHomebridgeStatus();
      expect(result).toEqual({ up: true });
    });
  });

  // ── API methods ───────────────────────────────────────────────

  describe('API methods', () => {
    async function clientWithAuth() {
      const client = await createClient();
      // Pre-authenticate
      fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'tok' }));
      return client;
    }

    it('getAccessories → GET /api/accessories', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse([{ uniqueId: 'a1' }]));
      const result = await client.getAccessories();
      expect(result).toEqual([{ uniqueId: 'a1' }]);
      expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8581/api/accessories');
    });

    it('getAccessoryLayout → GET /api/accessories/layout', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse([{ name: 'Living Room' }]));
      const result = await client.getAccessoryLayout();
      expect(result).toEqual([{ name: 'Living Room' }]);
    });

    it('setAccessoryCharacteristic → PUT /api/accessories/:id', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      await client.setAccessoryCharacteristic('acc1', 'On', true);
      const [url, opts] = fetchMock.mock.calls[1];
      expect(url).toBe('http://localhost:8581/api/accessories/acc1');
      expect(opts?.method).toBe('PUT');
      expect(JSON.parse(opts?.body as string)).toEqual({ characteristicType: 'On', value: true });
    });

    it('getConfig → GET /api/config-editor', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ bridge: {} }));
      const result = await client.getConfig();
      expect(result).toEqual({ bridge: {} });
    });

    it('updateConfig → POST /api/config-editor', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      await client.updateConfig({ bridge: { name: 'Test' } });
      const [, opts] = fetchMock.mock.calls[1];
      expect(opts?.method).toBe('POST');
    });

    it('getPlugins → GET /api/plugins', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse([{ name: 'homebridge-hue' }]));
      const result = await client.getPlugins();
      expect(result).toEqual([{ name: 'homebridge-hue' }]);
    });

    it('searchPlugins → GET /api/plugins/search/:query', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      await client.searchPlugins('camera');
      expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8581/api/plugins/search/camera');
    });

    it('lookupPlugin → GET /api/plugins/lookup/:name', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ name: 'homebridge-hue' }));
      await client.lookupPlugin('homebridge-hue');
      expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8581/api/plugins/lookup/homebridge-hue');
    });

    it('getPluginVersions → GET /api/plugins/lookup/:name/versions', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ tags: {} }));
      await client.getPluginVersions('homebridge-hue');
      expect(fetchMock.mock.calls[1][0]).toContain('/versions');
    });

    it('getPluginConfigSchema → GET /api/plugins/config-schema/:name', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ schema: {} }));
      await client.getPluginConfigSchema('homebridge-hue');
      expect(fetchMock.mock.calls[1][0]).toContain('/config-schema/homebridge-hue');
    });

    it('getPluginChangelog → GET /api/plugins/changelog/:name', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(textResponse('# Changelog'));
      const result = await client.getPluginChangelog('homebridge-hue');
      expect(result).toBe('# Changelog');
    });

    it('restartServer → PUT /api/server/restart', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      await client.restartServer();
      expect(fetchMock.mock.calls[1][1]?.method).toBe('PUT');
    });

    it('getPairingInfo → GET /api/server/pairing', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ setupCode: '123-45-678' }));
      const result = await client.getPairingInfo();
      expect(result).toEqual({ setupCode: '123-45-678' });
    });

    it('getCachedAccessories → GET /api/server/cached-accessories', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      const result = await client.getCachedAccessories();
      expect(result).toEqual([]);
    });

    it('removeCachedAccessory → DELETE /api/server/cached-accessories/:uuid', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      await client.removeCachedAccessory('uuid-123');
      const [url, opts] = fetchMock.mock.calls[1];
      expect(url).toContain('/cached-accessories/uuid-123');
      expect(opts?.method).toBe('DELETE');
    });

    it('resetCachedAccessories → PUT /api/server/reset-cached-accessories', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      await client.resetCachedAccessories();
      expect(fetchMock.mock.calls[1][0]).toContain('/reset-cached-accessories');
    });

    it('getSystemInfo → GET /api/platform-tools/system-information', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ cpu: {} }));
      const result = await client.getSystemInfo();
      expect(result).toEqual({ cpu: {} });
    });

    it('getLogFile → GET /api/platform-tools/hb-service/log/download', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(textResponse('[9/8/2026] Homebridge is running\n'));
      const result = await client.getLogFile();
      expect(fetchMock.mock.calls[1][0]).toBe(
        'http://localhost:8581/api/platform-tools/hb-service/log/download',
      );
      expect(result).toBe('[9/8/2026] Homebridge is running\n');
    });

    it('throws on non-ok API response', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(textResponse('Not Found', 404));
      await expect(client.getAccessories()).rejects.toThrow('Homebridge API error 404');
    });

    it('URL-encodes special characters in path params', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({}));
      await client.lookupPlugin('@scope/plugin');
      expect(fetchMock.mock.calls[1][0]).toBe(
        'http://localhost:8581/api/plugins/lookup/%40scope%2Fplugin',
      );
    });
  });
});
