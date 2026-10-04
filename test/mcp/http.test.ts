import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runHttpServer } from '../../src/mcp/http.js';
import type { RunningHttpServer } from '../../src/mcp/http.js';
import { mockClient } from './helpers.js';

let running: RunningHttpServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(extra: { readOnly?: boolean } = {}) {
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
    expect((await mcp.listPrompts()).prompts).toHaveLength(3);
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

  it('fails to start on a busy port', async () => {
    const first = await start();
    const port = Number(new URL(first.url).port);
    await expect(runHttpServer({ port, token: 't', client: mockClient(), live: false })).rejects.toThrow(/EADDRINUSE/);
  });
});
