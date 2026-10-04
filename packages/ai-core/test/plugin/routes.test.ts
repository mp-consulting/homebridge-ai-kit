import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAiConfig } from '../../src/core/config.js';
import { registerAiRoutes, testAiConnection } from '../../src/plugin/routes.js';
import type { PluginUiServer } from '../../src/plugin/routes.js';
import { fakeProvider } from '../providers/helpers.js';
import type { Reply } from '../providers/helpers.js';

function fakeServer(configPath?: string) {
  const handlers = new Map<string, (body: any) => unknown>();
  const events: Array<[string, unknown]> = [];
  const server: PluginUiServer = {
    homebridgeConfigPath: configPath,
    onRequest: (path, fn) => handlers.set(path, fn),
    pushEvent: (event, data) => events.push([event, data]),
  };
  return { server, events, call: (path: string, body: unknown = {}) => Promise.resolve(handlers.get(path)!(body)) };
}

function setup(replies: Reply[] = [], config = resolveAiConfig({ apiKey: 'k' })) {
  const fake = fakeProvider(replies);
  const ui = fakeServer();
  registerAiRoutes(ui.server, { pluginName: 'homebridge-ewelink', systemContext: 'Devices are Sonoff.', loadConfig: async () => config, createProvider: () => fake.provider });
  return { ...ui, ...fake };
}

describe('registerAiRoutes', () => {
  it('reports status without the key', async () => {
    const { call } = setup();
    const status = await call('/ai/status');
    expect(status).toEqual({ enabled: true, provider: 'anthropic', model: 'claude-sonnet-5-5', capabilities: expect.objectContaining({ tools: true }) });
    expect(JSON.stringify(status)).not.toContain('"k"');
  });

  it('reports a disabled or missing config', async () => {
    const ui = fakeServer();
    registerAiRoutes(ui.server, { loadConfig: async () => null });
    expect(await ui.call('/ai/status')).toEqual({ enabled: false, provider: null, model: null, capabilities: null });
    await expect(ui.call('/ai/ask', { prompt: 'x' })).rejects.toThrow('The Assistant is not set up');

    const off = fakeServer();
    registerAiRoutes(off.server, { loadConfig: async () => resolveAiConfig({ enabled: false }) });
    expect(await off.call('/ai/status')).toMatchObject({ enabled: false, provider: 'anthropic', capabilities: null });

    const nokey = fakeServer();
    registerAiRoutes(nokey.server, { loadConfig: async () => resolveAiConfig({}) });
    expect(await nokey.call('/ai/status')).toMatchObject({ enabled: false, capabilities: null });
  });

  it('reads the config from the server config path by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aikit-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ platforms: [{ platform: 'HomebridgeAiKit', provider: 'openai', apiKey: 'k' }] }));
    const ui = fakeServer(path);
    registerAiRoutes(ui.server);
    expect(await ui.call('/ai/status')).toMatchObject({ enabled: true, provider: 'openai', model: 'gpt-6.1-sol' });
  });

  it('explains an error and streams chunks for a requestId', async () => {
    const { call, events, requests } = setup([{ text: 'Power-cycle it.' }]);
    const result = await call('/ai/explain', { error: 'ETIMEDOUT', context: 'ctx', device: { id: 1 }, requestId: 'r1' });
    expect(result).toEqual({ text: 'Power-cycle it.', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(events).toEqual([
      ['ai:chunk', { requestId: 'r1', delta: 'Pow' }],
      ['ai:chunk', { requestId: 'r1', delta: 'er-cycle it.' }],
      ['ai:done', { requestId: 'r1' }],
    ]);
    expect(requests[0].system).toContain('homebridge-ewelink');
    expect(requests[0].system).toContain('Devices are Sonoff.');
  });

  it('cancels a request in flight with /ai/cancel', async () => {
    const config = resolveAiConfig({ apiKey: 'k' });
    let seen: AbortSignal | undefined;
    const fake = fakeProvider([]);
    const provider = {
      ...fake.provider,
      // Never answers: ends only when the request is aborted.
      async *stream(req: { signal?: AbortSignal }) {
        seen = req.signal;
        yield { type: 'text', delta: 'Hel' };
        await new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(req.signal?.reason)));
      },
    } as unknown as typeof fake.provider;
    const ui = fakeServer();
    registerAiRoutes(ui.server, { loadConfig: async () => config, createProvider: () => provider });

    const pending = ui.call('/ai/ask', { prompt: 'hi', requestId: 'r9' });
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(await ui.call('/ai/cancel', { requestId: 'r9' })).toEqual({ cancelled: true });
    await expect(pending).rejects.toThrow('cancelled');
    expect(seen?.aborted).toBe(true);
    // The browser already gave up: no error event, and the id is forgotten.
    expect(ui.events).toEqual([['ai:chunk', { requestId: 'r9', delta: 'Hel' }]]);
    expect(await ui.call('/ai/cancel', { requestId: 'r9' })).toEqual({ cancelled: false });
    expect(await ui.call('/ai/cancel', {})).toEqual({ cancelled: false });
  });

  it('answers a question without streaming when there is no requestId', async () => {
    const { call, events } = setup([{ text: 'Yes.' }]);
    expect(await call('/ai/ask', { prompt: 'Is it on?', context: 'c' })).toEqual({ text: 'Yes.', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(events).toEqual([]);
  });

  it('pushes ai:error and rethrows on failure', async () => {
    const { call, events } = setup();
    await expect(call('/ai/ask', { prompt: '', requestId: 'r2' })).rejects.toThrow('"prompt" is required');
    expect(events).toEqual([['ai:error', { requestId: 'r2', message: '"prompt" is required' }]]);
    await expect(call('/ai/explain', {})).rejects.toThrow('"error" is required');
  });

  it('generates a config against the schema', async () => {
    const { call } = setup([{ text: JSON.stringify({ config: { name: 'x' }, explanation: 'e' }) }]);
    const result = await call('/ai/config', { schema: { schema: { type: 'object', properties: { name: { type: 'string' } } } }, request: 'name it x', current: { name: 'y' } });
    expect(result).toMatchObject({ config: { name: 'x' }, explanation: 'e' });
    await expect(call('/ai/config', { request: 'r' })).rejects.toThrow('"schema" is required');
  });

  it('works without plugin context', async () => {
    const fake = fakeProvider([{ text: 'ok' }, { text: JSON.stringify({ config: {}, explanation: '' }) }]);
    const ui = fakeServer();
    registerAiRoutes(ui.server, { loadConfig: async () => resolveAiConfig({ apiKey: 'k' }), createProvider: () => fake.provider });
    await ui.call('/ai/explain', { error: 'E' });
    await ui.call('/ai/config', { schema: { type: 'object' }, request: 'r', current: 'not an object' });
    expect(fake.requests[0].system).not.toContain('settings of the Homebridge plugin');
  });
});

describe('testAiConnection', () => {
  it('reports success with latency and reply', async () => {
    const { provider } = fakeProvider([{ text: 'OK' }]);
    const result = await testAiConnection({ provider: 'anthropic', apiKey: 'k' }, () => provider);
    expect(result).toMatchObject({ ok: true, provider: 'anthropic', model: 'fake-model', reply: 'OK' });
    expect(result.latencyMs).toBeTypeOf('number');
  });

  it('reports failures without throwing or leaking keys', async () => {
    expect(await testAiConnection({ provider: 'nope' })).toEqual({ ok: false, message: expect.stringContaining('Unknown AI provider') });
    expect(await testAiConnection({ provider: 'openai' })).toEqual({ ok: false, message: 'openai: an API key is required' });
    const failing = () => {
      throw new Error('bad key sk-abcdefghijklmnopqrstuvwxyz');
    };
    expect((await testAiConnection({ apiKey: 'k' }, failing)).message).not.toContain('abcdefghijklmnop');
  });
});
