/**
 * Streamable HTTP transport for outside MCP clients. Every request needs
 * `Authorization: Bearer <token>`; each MCP session gets its own server.
 * Browser requests must come from an allowed `Origin` (DNS-rebinding
 * protection), idle sessions expire, and repeated bad tokens from one
 * address are slowed down.
 */

import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isIP } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './create-server.js';
import type { HomebridgeClient } from './homebridge-client.js';
import type { LiveSource } from './live.js';
import { createLiveSource, shareLiveSource } from './live.js';

export const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export const DEFAULT_MAX_SESSIONS = 32;
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;
/** Bad tokens an address may send before it has to wait. */
export const AUTH_FREE_FAILURES = 5;
/** The wait doubles with every further bad token, up to this. */
export const AUTH_MAX_DELAY_MS = 5 * 60_000;
/** An address's failures are forgotten this long after its last one. */
const AUTH_FORGET_MS = 15 * 60_000;
const AUTH_MAX_TRACKED = 10_000;

export interface HttpServerOptions {
  port?: number;
  /** Default 127.0.0.1. Binding elsewhere exposes Homebridge control to the network. */
  host?: string;
  /** Bearer token every request must carry. Required. */
  token: string;
  client: HomebridgeClient;
  readOnly?: boolean;
  /** Let `get_config` return real secrets when asked; ignored in read-only mode. */
  allowSecrets?: boolean;
  /** Change feed for `resources/subscribe`, shared by every session. Default: {@link createLiveSource}. */
  live?: LiveSource | false;
  /**
   * Browser origins allowed besides loopback ones (`http://localhost:3000`) and
   * the server's own IP address. `*` allows any. Requests without an `Origin`
   * header (non-browser clients) are always allowed.
   */
  allowedOrigins?: string[];
  /** Most concurrent sessions; the least recently used idle one is closed to make room. Default 32. */
  maxSessions?: number;
  /** A session with no request for this long is closed. Default 30 minutes. */
  sessionIdleMs?: number;
}

export interface RunningHttpServer {
  server: Server;
  /** e.g. http://127.0.0.1:8582/mcp */
  url: string;
  /** Open MCP sessions. */
  sessionCount(): number;
  /** Closes idle sessions now (also runs on a timer). `now` is for tests. */
  sweep(now?: number): void;
  close(): Promise<void>;
}

function sameToken(given: string, expected: string): boolean {
  // Hash both so the comparison is constant-time regardless of length.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string, headers?: Record<string, string>): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null }, headers);
}

function normalizeOrigin(origin: string): string {
  if (origin === '*' || origin === 'null') {
    return origin;
  }
  try {
    return new URL(origin).origin;
  } catch {
    throw new Error(`Invalid allowed origin "${origin}" (expected e.g. https://example.com:8443)`);
  }
}

function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * The MCP spec requires validating `Origin` so a web page can't reach a local
 * server through DNS rebinding. A rebinding page has a domain-name origin that
 * matches its `Host` header, so "same host" only counts for IP-literal hosts.
 */
export function isOriginAllowed(origin: string | undefined, host: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined) {
    return true;
  }
  if (allowed.has('*') || allowed.has(origin)) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (allowed.has(url.origin) || isLoopback(url.hostname)) {
    return true;
  }
  return url.host === host?.toLowerCase() && isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0;
}

/** Per-address count of bad tokens, with an exponential wait once it passes {@link AUTH_FREE_FAILURES}. */
class AuthThrottle {
  private readonly failures = new Map<string, { count: number; last: number; blockedUntil: number }>();

  /** Milliseconds `address` must still wait, or 0. */
  retryAfter(address: string, now = Date.now()): number {
    const entry = this.failures.get(address);
    return entry && entry.blockedUntil > now ? entry.blockedUntil - now : 0;
  }

  fail(address: string, now = Date.now()): void {
    const entry = this.failures.get(address) ?? { count: 0, last: now, blockedUntil: 0 };
    entry.count++;
    entry.last = now;
    if (entry.count > AUTH_FREE_FAILURES) {
      entry.blockedUntil = now + Math.min(1000 * 2 ** (entry.count - AUTH_FREE_FAILURES - 1), AUTH_MAX_DELAY_MS);
    }
    this.failures.delete(address);
    this.failures.set(address, entry);
    if (this.failures.size > AUTH_MAX_TRACKED) {
      this.failures.delete(this.failures.keys().next().value!);
    }
  }

  succeed(address: string): void {
    this.failures.delete(address);
  }

  prune(now = Date.now()): void {
    for (const [address, entry] of this.failures) {
      if (now - entry.last > AUTH_FORGET_MS && entry.blockedUntil <= now) {
        this.failures.delete(address);
      }
    }
  }
}

interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
  /** Requests (including open SSE streams) still in progress; a busy session is never idle. */
  active: number;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

export async function runHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const { token, client } = options;
  if (!token) {
    throw new Error('A bearer token is required to serve MCP over HTTP (set HOMEBRIDGE_AI_MCP_TOKEN)');
  }
  const host = options.host ?? '127.0.0.1';
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map((o) => o.trim()).filter(Boolean).map(normalizeOrigin));
  const maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
  const idleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  // One change feed for all sessions: N clients subscribed to a topic share one socket.
  const live = options.live === false ? false : shareLiveSource(options.live ?? createLiveSource(client));
  const sessions = new Map<string, Session>();
  const throttle = new AuthThrottle();

  const sweep = (now = Date.now()) => {
    for (const session of sessions.values()) {
      if (session.active === 0 && now - session.lastSeen >= idleMs) {
        void session.transport.close();
      }
    }
    throttle.prune(now);
  };
  const sweeper = setInterval(sweep, Math.max(1000, Math.min(idleMs / 2, 60_000)));
  sweeper.unref();

  /** Closes the least recently used idle session; false when every session is busy. */
  const evictOne = (): boolean => {
    let oldest: Session | undefined;
    for (const session of sessions.values()) {
      if (session.active === 0 && (!oldest || session.lastSeen < oldest.lastSeen)) {
        oldest = session;
      }
    }
    if (!oldest) {
      return false;
    }
    sessions.delete(oldest.transport.sessionId!);
    void oldest.transport.close();
    return true;
  };

  const track = (session: Session, res: ServerResponse) => {
    session.lastSeen = Date.now();
    session.active++;
    res.once('close', () => {
      session.active--;
      session.lastSeen = Date.now();
    });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== MCP_PATH) {
      return rpcError(res, 404, `Not found; the MCP endpoint is ${MCP_PATH}`);
    }
    if (!isOriginAllowed(req.headers.origin, req.headers.host, allowedOrigins)) {
      return rpcError(res, 403, 'Forbidden: origin not allowed');
    }
    const address = req.socket.remoteAddress ?? 'unknown';
    const wait = throttle.retryAfter(address);
    if (wait > 0) {
      return rpcError(res, 429, 'Too many failed authentication attempts', { 'Retry-After': String(Math.ceil(wait / 1000)) });
    }
    const auth = req.headers.authorization ?? '';
    const given = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? '';
    if (!given || !sameToken(given, token)) {
      throttle.fail(address);
      return rpcError(res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer realm="homebridge-ai-kit"' });
    }
    throttle.succeed(address);

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (error) {
        return rpcError(res, 400, `Invalid request body: ${(error as Error).message}`);
      }
      if (existing) {
        track(existing, res);
        return existing.transport.handleRequest(req, res, body);
      }
      if (sessionId !== undefined || !isInitializeRequest(body)) {
        return rpcError(res, sessionId === undefined ? 400 : 404, sessionId === undefined ? 'Missing mcp-session-id' : 'Unknown session');
      }
      if (sessions.size >= maxSessions && !evictOne()) {
        return rpcError(res, 503, `Too many active sessions (max ${maxSessions})`);
      }
      const session: Session = { transport: undefined as unknown as StreamableHTTPServerTransport, lastSeen: Date.now(), active: 0 };
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, session);
        },
      });
      session.transport = transport;
      const server = createServer(client, { readOnly: options.readOnly, allowSecrets: options.allowSecrets, live });
      transport.onclose = () => {
        if (transport.sessionId && sessions.get(transport.sessionId) === session) {
          sessions.delete(transport.sessionId);
        }
        void server.close();
      };
      await server.connect(transport);
      track(session, res);
      return transport.handleRequest(req, res, body);
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!existing) {
        return rpcError(res, sessionId === undefined ? 400 : 404, sessionId === undefined ? 'Missing mcp-session-id' : 'Unknown session');
      }
      track(existing, res);
      return existing.transport.handleRequest(req, res);
    }

    return rpcError(res, 405, 'Method not allowed', { Allow: 'GET, POST, DELETE' });
  };

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        rpcError(res, 500, (error as Error).message);
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => {
      clearInterval(sweeper);
      reject(error);
    });
    server.listen(options.port ?? 8582, host, () => {
      server.removeAllListeners('error');
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const urlHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    server,
    url: `http://${urlHost}:${address.port}${MCP_PATH}`,
    sessionCount: () => sessions.size,
    sweep,
    async close() {
      clearInterval(sweeper);
      await Promise.all([...sessions.values()].map((s) => s.transport.close()));
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
