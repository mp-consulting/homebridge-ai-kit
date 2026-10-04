import { describe, expect, it, vi } from 'vitest';
import { HomebridgeApiError, HomebridgeClient, requireGlassUi } from '../../src/mcp/homebridge-client.js';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const r of responses) {
    fetch.mockResolvedValueOnce(r);
  }
  const client = new HomebridgeClient({ url: 'http://hb:8581', token: 't', fetch });
  const call = (i = 0) => {
    const [url, init] = fetch.mock.calls[i];
    return { url: String(url), method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
  };
  return { client, call };
}

describe('HomebridgeApiError', () => {
  it('keeps the historical message and detects missing routes', () => {
    const e = new HomebridgeApiError(404, 'GET', '/api/scenes', '{"message":"Cannot GET /api/scenes"}');
    expect(e.message).toBe('Homebridge API error 404 GET /api/scenes: {"message":"Cannot GET /api/scenes"}');
    expect(e.missingRoute).toBe(true);
    expect(new HomebridgeApiError(404, 'GET', '/x', '<!doctype html>').missingRoute).toBe(true);
    expect(new HomebridgeApiError(404, 'POST', '/api/scenes/a/run', '{"message":"Scene not found."}').missingRoute).toBe(false);
    expect(new HomebridgeApiError(500, 'GET', '/x', 'Cannot GET /x').missingRoute).toBe(false);
  });

  it('is what a non-2xx response throws', async () => {
    const { client } = setup(json({ message: 'Cannot GET /api/scenes' }, 404));
    const error = await client.listScenes().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HomebridgeApiError);
    expect((error as HomebridgeApiError).status).toBe(404);
  });
});

describe('requireGlassUi', () => {
  it('turns a missing route into a Glass UI hint and passes the rest through', async () => {
    await expect(requireGlassUi('Scenes', () => Promise.reject(new HomebridgeApiError(404, 'GET', '/api/scenes', 'Cannot GET /api/scenes')))).rejects.toThrow(
      'Scenes requires Homebridge Glass UI (this Homebridge UI has no GET /api/scenes).',
    );
    await expect(requireGlassUi('Scenes', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(requireGlassUi('Scenes', async () => 1)).resolves.toBe(1);
  });
});

describe('HomebridgeClient extras', () => {
  it('lists and reads config backups (served as text)', async () => {
    const { client, call } = setup(
      json([{ id: '1', timestamp: 't' }]),
      new Response('{"bridge":{}}', { headers: { 'content-type': 'application/octet-stream' } }),
      json({ bridge: { a: 1 } }),
      new Response('[1]', { headers: { 'content-type': 'text/plain' } }),
    );
    expect(await client.listConfigBackups()).toEqual([{ id: '1', timestamp: 't' }]);
    expect(call(0)).toMatchObject({ url: 'http://hb:8581/api/config-editor/backups', method: 'GET' });
    expect(await client.getConfigBackup('1')).toEqual({ bridge: {} });
    expect(call(1).url).toBe('http://hb:8581/api/config-editor/backups/1');
    expect(await client.getConfigBackup('2')).toEqual({ bridge: { a: 1 } });
    await expect(client.getConfigBackup('3')).rejects.toThrow('Config backup 3 is not a JSON object');
  });

  it('creates and lists instance backups', async () => {
    const { client, call } = setup(new Response(''), json([]));
    await client.createInstanceBackup();
    expect(call(0)).toMatchObject({ url: 'http://hb:8581/api/backup', method: 'POST' });
    await client.listInstanceBackups();
    expect(call(1)).toMatchObject({ url: 'http://hb:8581/api/backup/scheduled-backups', method: 'GET' });
  });

  it('calls the scene endpoints', async () => {
    const scene = { name: 'Movie', actions: [{ uniqueId: 'a', characteristicType: 'On', value: false }], schedules: [] };
    const { client, call } = setup(json([]), json({ sceneId: 'ab', ok: true, results: [] }), json({ id: 'x', ...scene }));
    await client.listScenes();
    expect(call(0)).toMatchObject({ url: 'http://hb:8581/api/scenes', method: 'GET' });
    await client.runScene('a/b');
    expect(call(1)).toMatchObject({ url: 'http://hb:8581/api/scenes/a%2Fb/run', method: 'POST' });
    await client.createScene(scene);
    expect(call(2)).toMatchObject({ url: 'http://hb:8581/api/scenes', method: 'POST', body: scene });
  });

  it('reads child bridge health and sends test notifications', async () => {
    const { client, call } = setup(json({ bridges: [] }), json([]), json([]));
    await client.getChildBridgeHealth();
    expect(call(0).url).toBe('http://hb:8581/api/status/homebridge/child-bridges/health');
    await client.sendTestNotification('ntfy');
    expect(call(1)).toMatchObject({ url: 'http://hb:8581/api/notifications/test', method: 'POST', body: { channel: 'ntfy' } });
    await client.sendTestNotification();
    expect(call(2).body).toEqual({});
  });
});
