import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mcpClientSnippets } from '../../src/plugin/snippets.js';

const handlers = new Map<string, (body?: unknown) => unknown>();
// Plain arrays, not vi.fn(): the module is imported once in beforeAll, before per-test mock resets.
const readyCalls: unknown[] = [];
const routeCalls: unknown[][] = [];
const registerAiRoutes = (...args: unknown[]) => void routeCalls.push(args);
const testAiConnection = vi.fn(async () => ({ ok: true }));

vi.mock('@homebridge/plugin-ui-utils', () => ({
  HomebridgePluginUiServer: class {
    onRequest(path: string, handler: (body?: unknown) => unknown) {
      handlers.set(path, handler);
    }
    ready() {
      readyCalls.push(this);
    }
  },
}));

// server.js imports ../dist/plugin/index.js, aliased to the sources in the vitest config.
vi.mock('../../src/plugin/index.ts', async () => ({
  mcpClientSnippets: (await import('../../src/plugin/snippets.js')).mcpClientSnippets,
  registerAiRoutes,
  testAiConnection,
}));

beforeAll(async () => {
  // @ts-expect-error -- plain JavaScript without types
  await import('../../homebridge-ui/server.js');
});

describe('homebridge-ui/server.js', () => {
  it('registers the shared Assistant routes and signals ready', () => {
    expect(routeCalls).toEqual([[expect.anything(), { pluginName: '@mp-consulting/homebridge-ai-kit' }]]);
    expect(readyCalls).toHaveLength(1);
    expect([...handlers.keys()].sort()).toEqual(['/ai/test', '/mcp/snippets', '/mcp/token']);
  });

  it('tests the provider settings from the form', async () => {
    const block = { provider: 'anthropic', apiKey: 'k' };
    await expect(handlers.get('/ai/test')!(block)).resolves.toEqual({ ok: true });
    expect(testAiConnection).toHaveBeenCalledWith(block);
  });

  it('generates random URL-safe client tokens', () => {
    const a = handlers.get('/mcp/token')!() as { token: string };
    const b = handlers.get('/mcp/token')!() as { token: string };
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a.token).not.toBe(b.token);
  });

  it('returns client snippets', () => {
    const body = { homebridgeUrl: 'http://hb.local:8581' };
    expect(handlers.get('/mcp/snippets')!(body)).toEqual(mcpClientSnippets(body));
  });
});
