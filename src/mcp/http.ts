/**
 * Streamable HTTP transport for outside MCP clients. Every request needs
 * `Authorization: Bearer <token>`; each MCP session gets its own server.
 */

import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './create-server.js';
import type { HomebridgeClient } from './homebridge-client.js';
import type { LiveSource } from './live.js';

export const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpServerOptions {
  port?: number;
  /** Default 127.0.0.1. Binding elsewhere exposes Homebridge control to the network. */
  host?: string;
  /** Bearer token every request must carry. Required. */
  token: string;
  client: HomebridgeClient;
  readOnly?: boolean;
  live?: LiveSource | false;
}

export interface RunningHttpServer {
  server: Server;
  /** e.g. http://127.0.0.1:8582/mcp */
  url: string;
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
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== MCP_PATH) {
      return rpcError(res, 404, `Not found; the MCP endpoint is ${MCP_PATH}`);
    }
    const auth = req.headers.authorization ?? '';
    const given = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? '';
    if (!given || !sameToken(given, token)) {
      return rpcError(res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer realm="homebridge-ai-kit"' });
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (error) {
        return rpcError(res, 400, `Invalid request body: ${(error as Error).message}`);
      }
      if (existing) {
        return existing.handleRequest(req, res, body);
      }
      if (sessionId !== undefined || !isInitializeRequest(body)) {
        return rpcError(res, sessionId === undefined ? 400 : 404, sessionId === undefined ? 'Missing mcp-session-id' : 'Unknown session');
      }
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
      const server = createServer(client, { readOnly: options.readOnly, live: options.live });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
        void server.close();
      };
      await server.connect(transport);
      return transport.handleRequest(req, res, body);
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!existing) {
        return rpcError(res, sessionId === undefined ? 400 : 404, sessionId === undefined ? 'Missing mcp-session-id' : 'Unknown session');
      }
      return existing.handleRequest(req, res);
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
    server.once('error', reject);
    server.listen(options.port ?? 8582, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const urlHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    server,
    url: `http://${urlHost}:${address.port}${MCP_PATH}`,
    async close() {
      await Promise.all([...transports.values()].map((t) => t.close()));
      transports.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
