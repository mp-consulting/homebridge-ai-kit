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
    for (const [key, value] of Object.entries(ENV)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv('HOMEBRIDGE_TIMEOUT_MS', undefined);
    fetchMock = mockFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function createClient() {
    // Dynamic import so each test gets a fresh module with current env
    const mod = await import('../../src/mcp/homebridge-client.js');
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
      vi.stubEnv('HOMEBRIDGE_URL', undefined);
      await expect(createClient()).rejects.toThrow('HOMEBRIDGE_URL');
    });

    it('throws when HOMEBRIDGE_USERNAME is missing', async () => {
      vi.stubEnv('HOMEBRIDGE_USERNAME', undefined);
      await expect(createClient()).rejects.toThrow('HOMEBRIDGE_USERNAME');
    });

    it('throws when HOMEBRIDGE_PASSWORD is missing', async () => {
      vi.stubEnv('HOMEBRIDGE_PASSWORD', undefined);
      await expect(createClient()).rejects.toThrow('HOMEBRIDGE_PASSWORD');
    });

    it('strips trailing slashes from URL', async () => {
      vi.stubEnv('HOMEBRIDGE_URL', 'http://localhost:8581///');
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
      expect(url).toBe('http://localhost:8581/api/server/cached-accessories/uuid-123');
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

    it('getAccessory → GET /api/accessories/:id', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ uniqueId: 'a 1' }));
      const result = await client.getAccessory('a 1');
      expect(result).toEqual({ uniqueId: 'a 1' });
      expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8581/api/accessories/a%201');
    });

    it('removeCachedAccessory passes cacheFile as a query parameter', async () => {
      const client = await clientWithAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({}));
      await client.removeCachedAccessory('u1', 'cachedAccessories.0E12');
      expect(fetchMock.mock.calls[1][0]).toBe(
        'http://localhost:8581/api/server/cached-accessories/u1?cacheFile=cachedAccessories.0E12',
      );
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

  // ── Constructor validation ────────────────────────────────────

  describe('configuration validation', () => {
    it('rejects a malformed URL', async () => {
      vi.stubEnv('HOMEBRIDGE_URL', 'not a url');
      await expect(createClient()).rejects.toThrow('HOMEBRIDGE_URL is not a valid URL');
    });

    it('rejects a non-http scheme', async () => {
      vi.stubEnv('HOMEBRIDGE_URL', 'ftp://homebridge.local');
      await expect(createClient()).rejects.toThrow('must use http or https');
    });

    it('rejects an invalid timeout', async () => {
      vi.stubEnv('HOMEBRIDGE_TIMEOUT_MS', 'soon');
      await expect(createClient()).rejects.toThrow('HOMEBRIDGE_TIMEOUT_MS');
    });

    it('warns about plain http to a public host only', async () => {
      vi.stubEnv('HOMEBRIDGE_URL', 'http://homebridge.example.com:8581');
      expect((await createClient()).transportWarning).toContain('unencrypted');

      for (const url of ['http://localhost:8581', 'http://192.168.1.10:8581', 'http://homebridge.local', 'https://hb.example.com']) {
        vi.stubEnv('HOMEBRIDGE_URL', url);
        expect((await createClient()).transportWarning).toBeNull();
      }
    });
  });

  // ── Concurrency ───────────────────────────────────────────────

  describe('concurrent requests', () => {
    function routeFetch(handlers: Record<string, () => Response>) {
      fetchMock.mockImplementation(async (input) => {
        const path = new URL(String(input)).pathname;
        const handler = handlers[path];
        return handler ? handler() : jsonResponse([]);
      });
    }

    it('logs in once for parallel first requests', async () => {
      const client = await createClient();
      routeFetch({ '/api/auth/login': () => jsonResponse({ access_token: 'tok' }) });

      await Promise.all([client.getAccessories(), client.getAccessoryLayout(), client.getPlugins()]);

      const logins = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/login'));
      expect(logins).toHaveLength(1);
    });

    it('refreshes once when parallel requests all see a 401', async () => {
      const client = await createClient();
      let token = 'old';
      fetchMock.mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/auth/login') {
          return jsonResponse({ access_token: token });
        }
        if (path === '/api/auth/refresh') {
          token = 'new';
          return jsonResponse({ access_token: 'new' });
        }
        const auth = (init?.headers as Record<string, string>).Authorization;
        return auth === `Bearer ${token}` ? jsonResponse([]) : textResponse('Unauthorized', 401);
      });
      await client.getAccessories(); // log in with "old"
      token = 'rotated'; // server-side expiry: "old" is now rejected

      await Promise.all([client.getAccessories(), client.getPlugins(), client.getCachedAccessories()]);

      const refreshes = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/refresh'));
      expect(refreshes).toHaveLength(1);
    });
  });

  // ── Failure modes ─────────────────────────────────────────────

  describe('failure modes', () => {
    it('reports an unreachable host with the underlying cause', async () => {
      const client = await createClient();
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:8581') }));

      await expect(client.getAccessories()).rejects.toThrow(
        'Cannot reach Homebridge at http://localhost:8581 (POST /api/auth/login): connect ECONNREFUSED',
      );
    });

    it('times out a request that never answers', async () => {
      vi.stubEnv('HOMEBRIDGE_TIMEOUT_MS', '50');
      const client = await createClient();
      fetchMock.mockImplementation((_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
      );

      await expect(client.getAccessories()).rejects.toThrow('Homebridge did not respond within 50ms (POST /api/auth/login)');
    });

    it('passes an abort signal on every request', async () => {
      const client = await createClient();
      setupAuthAndApi(jsonResponse([]));
      await client.getAccessories();
      for (const [, init] of fetchMock.mock.calls) {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
      }
    });

    it('re-authenticates when the refresh request itself throws', async () => {
      const client = await createClient();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: 'tok1' }))
        .mockResolvedValueOnce(textResponse('Unauthorized', 401))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse({ access_token: 'tok2' }))
        .mockResolvedValueOnce(jsonResponse({ up: true }));

      await expect(client.getHomebridgeStatus()).resolves.toEqual({ up: true });
      expect(fetchMock.mock.calls[3][0]).toBe('http://localhost:8581/api/auth/login');
    });

    it('gives up after one retry when the retry is also unauthorized', async () => {
      const client = await createClient();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: 'tok1' }))
        .mockResolvedValueOnce(textResponse('Unauthorized', 401))
        .mockResolvedValueOnce(jsonResponse({ access_token: 'tok2' }))
        .mockResolvedValueOnce(textResponse('Forbidden by policy', 401));

      await expect(client.getHomebridgeStatus()).rejects.toThrow('Homebridge API error 401 GET /api/status/homebridge: Forbidden by policy');
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('returns text for a 2xx response that is not JSON', async () => {
      const client = await createClient();
      setupAuthAndApi(textResponse('OK'));
      await expect(client.restartServer()).resolves.toBe('OK');
    });
  });

  // ── Log streaming ─────────────────────────────────────────────

  describe('getLogTail', () => {
    function streamResponse(chunks: string[]) {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/plain' } });
    }

    it('reads the log download endpoint', async () => {
      const client = await createClient();
      setupAuthAndApi(textResponse('[9/8/2026] Homebridge is running\n'));
      const result = await client.getLogTail(1024);
      expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8581/api/platform-tools/hb-service/log/download');
      expect(result).toEqual({ text: '[9/8/2026] Homebridge is running\n', truncated: false });
    });

    it('keeps only the last maxBytes of a streamed log', async () => {
      const client = await createClient();
      setupAuthAndApi(streamResponse(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dd\nlast\n']));
      const result = await client.getLogTail(12);
      expect(result).toEqual({ text: 'ccccdd\nlast\n', truncated: true });
    });

    it('is not truncated when the log is exactly maxBytes', async () => {
      const client = await createClient();
      setupAuthAndApi(streamResponse(['12345', '67890']));
      expect(await client.getLogTail(10)).toEqual({ text: '1234567890', truncated: false });
    });

    it('surfaces API errors', async () => {
      const client = await createClient();
      setupAuthAndApi(textResponse('Log file not found', 404));
      await expect(client.getLogTail(10)).rejects.toThrow('Homebridge API error 404');
    });
  });
});
