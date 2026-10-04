import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import initializer from '../../src/index.js';
import * as main from '../../src/index.js';
import * as plugin from '../../src/plugin/index.js';
import { AiKitPlatform } from '../../src/plugin/platform.js';

function setup(config: unknown, storagePath?: string) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const api = Object.assign(new EventEmitter(), storagePath ? { user: { storagePath: () => storagePath } } : {});
  const platform = new AiKitPlatform(log, config, api);
  return { log, api, platform };
}

function freePort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AiKitPlatform', () => {
  it('registers itself with Homebridge', () => {
    const api = { registerPlatform: vi.fn() };
    initializer(api);
    expect(api.registerPlatform).toHaveBeenCalledWith('HomebridgeAiKit', AiKitPlatform);
    expect(main.PLATFORM_NAME).toBe('HomebridgeAiKit');
    expect(plugin.AiKitPlatform).toBe(AiKitPlatform);
  });

  it('logs the provider status', () => {
    const { log, platform } = setup({ provider: 'anthropic', apiKey: 'k' });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Assistant ready: anthropic / claude-sonnet-5-5 (tools, 1000000 token context)'));
    platform.configureAccessory();
    expect(setup({ enabled: false }).log.info).toHaveBeenCalledWith('Assistant disabled.');
    expect(setup({}).log.warn).toHaveBeenCalledWith('Assistant not ready: anthropic: an API key is required');
    expect(setup({ provider: 'openai-compatible' }).log.info).toHaveBeenCalledWith(expect.stringContaining('(tools, 8192 token context)'));
  });

  it('reports an invalid config', () => {
    const { log, platform } = setup({ provider: 'apple' });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Unknown AI provider'));
    expect(platform.config).toBeNull();
  });

  it('starts and stops the HTTP MCP server', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    const { log, api, platform } = setup({
      apiKey: 'k',
      mcp: { http: { enabled: true, port, token: 'tok', homebridgeUrl: 'http://127.0.0.1:1', homebridgeToken: 'hbg_x' } },
    });
    api.emit('didFinishLaunching');
    await platform.ready;
    const started = log.info.mock.calls.find(([m]) => String(m).startsWith('MCP server listening at'));
    expect(started).toBeDefined();
    const url = String(started![0]).split(' at ')[1];
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
    api.emit('shutdown');
  });

  it('serves read-only with scoped tokens and audits writes in the storage path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-kit-platform-'));
    vi.stubEnv('HOMEBRIDGE_AI_MCP_TOKEN', '');
    const { log, api, platform } = setup(
      { apiKey: 'k', mcp: { http: { enabled: true, port: await freePort(), readOnly: true, clients: [{ token: 'c', scope: 'control' }], homebridgeToken: 'hbg_x' } } },
      dir,
    );
    api.emit('didFinishLaunching');
    await platform.ready;
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/^MCP server listening at .* \(read-only\)$/));
    expect(log.info).toHaveBeenCalledWith(`MCP write tool calls are logged to ${join(dir, 'homebridge-ai-kit-audit.jsonl')}`);
    api.emit('shutdown');

    const off = setup({ apiKey: 'k', mcp: { http: { enabled: true, port: await freePort(), token: 't', auditLog: false, homebridgeToken: 'hbg_x' } } });
    off.api.emit('didFinishLaunching');
    await off.platform.ready;
    expect(off.log.info).not.toHaveBeenCalledWith(expect.stringContaining('logged to'));
    off.api.emit('shutdown');
    await rm(dir, { recursive: true, force: true });
  });

  it('does nothing when HTTP is disabled', async () => {
    const { log, api, platform } = setup({ apiKey: 'k' });
    api.emit('didFinishLaunching');
    await platform.ready;
    expect(log.error).not.toHaveBeenCalled();
    api.emit('shutdown');
  });

  it('refuses to start without a token or Homebridge credentials', async () => {
    vi.stubEnv('HOMEBRIDGE_AI_MCP_TOKEN', '');
    const a = setup({ apiKey: 'k', mcp: { http: { enabled: true } } });
    a.api.emit('didFinishLaunching');
    await a.platform.ready;
    expect(a.log.error).toHaveBeenCalledWith(expect.stringContaining('has no token'));

    vi.stubEnv('HOMEBRIDGE_TOKEN', '');
    vi.stubEnv('HOMEBRIDGE_USERNAME', '');
    vi.stubEnv('HOMEBRIDGE_URL', '');
    const b = setup({ apiKey: 'k', mcp: { http: { enabled: true, token: 't' } } });
    b.api.emit('didFinishLaunching');
    await b.platform.ready;
    expect(b.log.error).toHaveBeenCalledWith(expect.stringContaining('HOMEBRIDGE_USERNAME'));
    expect(b.log.error.mock.calls[0][0]).toContain('Set a Homebridge API token');
  });

  it('passes the trusted certificate settings to the Homebridge client', async () => {
    const d = setup({ apiKey: 'k', mcp: { http: { enabled: true, token: 't', homebridgeUrl: 'http://127.0.0.1:8581', homebridgeToken: 'hbg', homebridgeCertFingerprint: 'AB' } } });
    d.api.emit('didFinishLaunching');
    await d.platform.ready;
    expect(d.log.error).toHaveBeenCalledWith('MCP over HTTP not started: HOMEBRIDGE_CERT_FINGERPRINT and HOMEBRIDGE_CERT_PATH only apply to an https HOMEBRIDGE_URL.');
  });

  it('logs a bind failure', async () => {
    vi.stubEnv('HOMEBRIDGE_AI_MCP_TOKEN', 'envtok');
    const c = setup({ apiKey: 'k', mcp: { http: { enabled: true, host: '203.0.113.1', port: 1, homebridgeToken: 'hbg' } } });
    c.api.emit('didFinishLaunching');
    await c.platform.ready;
    expect(c.log.error).toHaveBeenCalledWith(expect.stringMatching(/^MCP over HTTP not started: /));
  });
});
