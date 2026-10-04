import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AUTH_FREE_FAILURES, isOriginAllowed, runHttpServer } from '../../src/mcp/http.js';
import type { HttpServerOptions, RunningHttpServer } from '../../src/mcp/http.js';
import type { LiveSource } from '../../src/mcp/live.js';
import { mockClient } from './helpers.js';

let running: RunningHttpServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(extra: Partial<HttpServerOptions> = {}) {
  running = await runHttpServer({ port: 0, token: 'secret-token', client: mockClient(), live: false, ...extra });
  return running;
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } },
};

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('runHttpServer', () => {
  it('requires a token', async () => {
    await expect(runHttpServer({ token: '', client: mockClient() })).rejects.toThrow('bearer token is required');
  });

  it('serves MCP to an authenticated client', async () => {
    const { url } = await start({ readOnly: true });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const mcp = new Client({ name: 'test', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: 'Bearer secret-token' } } });
    await mcp.connect(transport);
    const { tools } = await mcp.listTools();
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    expect((await mcp.listPrompts()).prompts).toHaveLength(6);
    await transport.terminateSession();
    await mcp.close();
  });

  it('rejects missing or wrong tokens', async () => {
    const { url } = await start();
    const none = await post(url, INIT);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('Bearer');
    expect((await post(url, INIT, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post(url, INIT, { Authorization: 'Basic abc' })).status).toBe(401);
  });

  it('answers protocol errors', async () => {
    const { url } = await start();
    const auth = { Authorization: 'Bearer secret-token' };
    expect((await post(url.replace('/mcp', '/other'), INIT, auth)).status).toBe(404);
    expect((await post(url, '{bad', auth)).status).toBe(400);
    expect((await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth)).status).toBe(400);
    expect((await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ...auth, 'mcp-session-id': 'nope' })).status).toBe(404);
    expect((await fetch(url, { headers: auth })).status).toBe(400);
    expect((await fetch(url, { method: 'DELETE', headers: { ...auth, 'mcp-session-id': 'nope' } })).status).toBe(404);
    expect((await fetch(url, { method: 'PUT', headers: auth })).status).toBe(405);
    expect((await post(url, 'x'.repeat(5 * 1024 * 1024), auth)).status).toBe(400);
    expect((await post(url, '', auth)).status).toBe(400);
  });

  it('initialises a session with a raw request', async () => {
    const { url } = await start();
    const res = await post(url, INIT, { Authorization: 'Bearer secret-token' });
    expect(res.status).toBe(200);
    const sessionId = res.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    expect(await res.text()).toContain('homebridge-ai-kit');
    const del = await fetch(url, { method: 'DELETE', headers: { Authorization: 'Bearer secret-token', 'mcp-session-id': sessionId! } });
    expect(del.status).toBe(200);
  });

  it('validates the Origin header', async () => {
    const { url } = await start({ allowedOrigins: ['https://app.example.com/'] });
    const auth = { Authorization: 'Bearer secret-token' };
    const port = new URL(url).port;
    expect((await post(url, INIT, { ...auth, Origin: 'https://evil.example' })).status).toBe(403);
    // DNS rebinding: a domain name pointed at 127.0.0.1, so Origin and Host agree.
    expect((await post(url, INIT, { ...auth, Origin: `http://rebind.example:${port}`, Host: `rebind.example:${port}` })).status).toBe(403);
    expect((await post(url, INIT, { ...auth, Origin: 'https://app.example.com' })).status).toBe(200);
    expect((await post(url, INIT, { ...auth, Origin: 'http://localhost:5173' })).status).toBe(200);
    expect((await post(url, INIT, { ...auth, Origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    // No Origin: a non-browser client.
    expect((await post(url, INIT, auth)).status).toBe(200);
  });

  it('rejects an invalid allowed origin at startup', async () => {
    await expect(runHttpServer({ token: 't', client: mockClient(), live: false, allowedOrigins: ['not a url'] })).rejects.toThrow('Invalid allowed origin');
  });

  it('slows down repeated bad tokens from one address', async () => {
    const { url } = await start();
    for (let i = 0; i < AUTH_FREE_FAILURES; i++) {
      expect((await post(url, INIT, { Authorization: 'Bearer wrong' })).status).toBe(401);
    }
    expect((await post(url, INIT, { Authorization: 'Bearer wrong' })).status).toBe(401);
    const blocked = await post(url, INIT, { Authorization: 'Bearer secret-token' });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('forgets failures after a good token', async () => {
    const { url } = await start();
    for (let i = 0; i < AUTH_FREE_FAILURES; i++) {
      await post(url, INIT, { Authorization: 'Bearer wrong' });
    }
    expect((await post(url, INIT, { Authorization: 'Bearer secret-token' })).status).toBe(200);
    for (let i = 0; i < AUTH_FREE_FAILURES; i++) {
      expect((await post(url, INIT, { Authorization: 'Bearer wrong' })).status).toBe(401);
    }
  });

  it('closes idle sessions and caps how many stay open', async () => {
    const running = await start({ maxSessions: 2, sessionIdleMs: 60_000 });
    const auth = { Authorization: 'Bearer secret-token' };
    const open = async () => {
      const res = await post(running.url, INIT, auth);
      await res.text();
      return res.headers.get('mcp-session-id')!;
    };
    const first = await open();
    await open();
    expect(running.sessionCount()).toBe(2);
    // A third session evicts the least recently used one.
    await open();
    expect(running.sessionCount()).toBe(2);
    const gone = await post(running.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ...auth, 'mcp-session-id': first });
    expect(gone.status).toBe(404);

    running.sweep(Date.now() + 30_000);
    expect(running.sessionCount()).toBe(2);
    running.sweep(Date.now() + 61_000);
    await vi.waitFor(() => expect(running.sessionCount()).toBe(0));
  });

  it('refuses a new session when every open one is busy', async () => {
    const running = await start({ maxSessions: 1 });
    const auth = { Authorization: 'Bearer secret-token' };
    const res = await post(running.url, INIT, auth);
    const sessionId = res.headers.get('mcp-session-id')!;
    await res.text();
    // An open SSE stream keeps the session busy.
    const controller = new AbortController();
    const stream = await fetch(running.url, { headers: { ...auth, Accept: 'text/event-stream', 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' }, signal: controller.signal });
    expect(stream.status).toBe(200);
    expect((await post(running.url, INIT, auth)).status).toBe(503);
    running.sweep(Date.now() + 365 * 86_400_000);
    expect(running.sessionCount()).toBe(1);
    controller.abort();
  });

  it('shares one change feed across sessions', async () => {
    const close = vi.fn();
    const live = vi.fn<LiveSource>(() => ({ close }));
    const { url } = await start({ live });
    const connect = async () => {
      const mcp = new Client({ name: 'test', version: '0' });
      const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: 'Bearer secret-token' } } });
      await mcp.connect(transport);
      await mcp.subscribeResource({ uri: 'homebridge://accessories' });
      return { mcp, transport };
    };
    const a = await connect();
    const b = await connect();
    expect(live).toHaveBeenCalledTimes(1);
    await a.mcp.unsubscribeResource({ uri: 'homebridge://accessories' });
    expect(close).not.toHaveBeenCalled();
    await b.mcp.unsubscribeResource({ uri: 'homebridge://accessories' });
    expect(close).toHaveBeenCalledTimes(1);
    await a.mcp.close();
    await b.mcp.close();
  });

  it('gives each token its scope and keeps sessions to the token that opened them', async () => {
    const records: Array<Record<string, unknown>> = [];
    const client = mockClient({ restartServer: vi.fn().mockResolvedValue(undefined) });
    running = await runHttpServer({
      port: 0,
      token: 'admin-token',
      clients: [{ token: 'read-token', scope: 'read', name: 'Dashboard' }, { token: 'control-token', scope: 'control' }],
      client,
      live: false,
      audit: { record: (e) => void records.push(e as unknown as Record<string, unknown>) },
    });
    const { url } = running;
    const connect = async (token: string) => {
      const mcp = new Client({ name: 'test', version: '0' });
      const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
      await mcp.connect(transport);
      const names = (await mcp.listTools()).tools.map((t) => t.name);
      return { mcp, transport, names };
    };
    const reader = await connect('read-token');
    expect(reader.names).not.toContain('set_accessory');
    const controller = await connect('control-token');
    expect(controller.names).toContain('set_accessory');
    expect(controller.names).not.toContain('restart_homebridge');
    const admin = await connect('admin-token');
    expect(admin.names).toContain('restart_homebridge');

    await admin.mcp.callTool({ name: 'restart_homebridge', arguments: {} });
    expect(records).toEqual([expect.objectContaining({ tool: 'restart_homebridge', principal: 'default', scope: 'admin', session: admin.transport.sessionId })]);

    // A read token can't ride on the admin session.
    const hijack = await post(url, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, { Authorization: 'Bearer read-token', 'mcp-session-id': admin.transport.sessionId! });
    expect(hijack.status).toBe(403);
    for (const c of [reader, controller, admin]) {
      await c.mcp.close();
    }
  });

  it('caps every token at read in read-only mode and serves with only scoped tokens', async () => {
    running = await runHttpServer({ port: 0, clients: [{ token: 'c', scope: 'control' }], readOnly: true, client: mockClient(), live: false });
    const mcp = new Client({ name: 'test', version: '0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(running.url), { requestInit: { headers: { Authorization: 'Bearer c' } } }));
    expect((await mcp.listTools()).tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    await mcp.close();
  });

  it('rejects bad client tokens at startup', async () => {
    const base = { client: mockClient(), live: false as const };
    await expect(runHttpServer({ ...base, clients: [{ token: ' ', scope: 'read' }] })).rejects.toThrow('MCP client "client-1" has no token');
    await expect(runHttpServer({ ...base, clients: [{ token: 'x', scope: 'root' as never, name: 'A' }] })).rejects.toThrow('MCP client "A" has an unknown scope "root"');
    await expect(runHttpServer({ ...base, token: 'x', clients: [{ token: 'x', scope: 'read' }] })).rejects.toThrow('reuses another client');
  });

  it('fails to start on a busy port', async () => {
    const first = await start();
    const port = Number(new URL(first.url).port);
    await expect(runHttpServer({ port, token: 't', client: mockClient(), live: false })).rejects.toThrow(/EADDRINUSE/);
  });
});

describe('isOriginAllowed', () => {
  const none = new Set<string>();
  it('allows loopback, IP same-host and listed origins only', () => {
    expect(isOriginAllowed(undefined, 'x', none)).toBe(true);
    expect(isOriginAllowed('http://[::1]:3000', 'x', none)).toBe(true);
    expect(isOriginAllowed('http://app.localhost', 'x', none)).toBe(true);
    expect(isOriginAllowed('http://192.168.1.5:8582', '192.168.1.5:8582', none)).toBe(true);
    expect(isOriginAllowed('http://192.168.1.5:8582', '192.168.1.5:9999', none)).toBe(false);
    expect(isOriginAllowed('null', 'x', none)).toBe(false);
    expect(isOriginAllowed('null', 'x', new Set(['null']))).toBe(true);
    expect(isOriginAllowed('https://a.example', 'x', new Set(['*']))).toBe(true);
    expect(isOriginAllowed('https://a.example', undefined, none)).toBe(false);
  });
});
