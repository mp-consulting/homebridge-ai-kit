import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTrustedFetch, normalizeFingerprint, pemFingerprints } from '../../src/mcp/tls.js';
import { HomebridgeClient } from '../../src/mcp/homebridge-client.js';

// Test-only certificates (valid until 2125), generated with openssl:
// self-signed.pem (CN=self-signed.local), other.pem (another self-signed one),
// leaf.pem (SAN IP:127.0.0.1) issued by ca.pem.
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/tls/${name}`, import.meta.url));
const read = (name: string) => readFileSync(fixture(name), 'utf8');
const SELF_SIGNED = read('self-signed.pem');
const OTHER = read('other.pem');
const CA = read('ca.pem');
const fp = (pem: string) => new X509Certificate(pem).fingerprint256;

function listen(server: Server, protocol: 'http' | 'https'): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`${protocol}://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

const handler: RequestListener = (_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
};

let selfSignedUrl: string;
let caSignedUrl: string;
let plainUrl: string;
const servers: Server[] = [];

beforeAll(async () => {
  const selfSigned = createHttpsServer({ cert: SELF_SIGNED, key: read('self-signed.key') }, handler);
  const caSigned = createHttpsServer({ cert: read('leaf.pem'), key: read('leaf.key') }, handler);
  const plain = createHttpServer(handler);
  servers.push(selfSigned, caSigned, plain);
  selfSignedUrl = await listen(selfSigned, 'https');
  caSignedUrl = await listen(caSigned, 'https');
  plainUrl = await listen(plain, 'http');
});

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The message of the network error behind a failed fetch. */
async function failure(promise: Promise<unknown>): Promise<string> {
  const error = (await promise.then(
    () => {
      throw new Error('expected the request to fail');
    },
    (e: unknown) => e,
  )) as Error;
  return error.cause instanceof Error ? error.cause.message : error.message;
}

describe('normalizeFingerprint', () => {
  const hex = 'ab'.repeat(32);
  const canonical = Array(32).fill('AB').join(':');

  it('accepts colons, spaces, any case and an openssl prefix', () => {
    expect(normalizeFingerprint(hex)).toBe(canonical);
    expect(normalizeFingerprint(canonical.toLowerCase())).toBe(canonical);
    expect(normalizeFingerprint(`SHA256 Fingerprint=${canonical}`)).toBe(canonical);
    expect(normalizeFingerprint(` sha256/${hex.match(/../g)!.join(' ')} `)).toBe(canonical);
  });

  it('rejects anything that is not 32 bytes of hex', () => {
    expect(() => normalizeFingerprint('AB:CD')).toThrow('must be a SHA-256 fingerprint');
    expect(() => normalizeFingerprint('zz'.repeat(32))).toThrow('must be a SHA-256 fingerprint');
  });
});

describe('pemFingerprints', () => {
  it('lists every certificate in a PEM and rejects a file without one', () => {
    expect(pemFingerprints(SELF_SIGNED + OTHER)).toEqual([fp(SELF_SIGNED), fp(OTHER)]);
    expect(() => pemFingerprints('not a certificate')).toThrow('no PEM certificate found');
  });
});

describe('createTrustedFetch', () => {
  it('needs a fingerprint or a certificate', () => {
    expect(() => createTrustedFetch({})).toThrow('Set a certificate fingerprint or a certificate file');
  });

  it('leaves global fetch verifying certificates', async () => {
    expect(await failure(fetch(selfSignedUrl))).toMatch(/self[- ]signed/i);
  });

  it('trusts a self-signed certificate pinned by its fingerprint', async () => {
    const trusted = createTrustedFetch({ fingerprint: fp(SELF_SIGNED).replace(/:/g, '').toLowerCase() });
    expect(await (await trusted(selfSignedUrl)).json()).toEqual({ ok: true });
    // Plain http is unaffected
    expect((await trusted(plainUrl)).status).toBe(200);
  });

  it('passes connection errors through when pinned by fingerprint', async () => {
    const closed = createHttpServer();
    const url = await listen(closed, 'https');
    await new Promise((resolve) => closed.close(resolve));
    expect(await failure(createTrustedFetch({ fingerprint: fp(OTHER) })(url))).toMatch(/ECONNREFUSED/);
  });

  it('refuses any other certificate when pinned by fingerprint', async () => {
    const trusted = createTrustedFetch({ fingerprint: fp(OTHER) });
    const message = await failure(trusted(selfSignedUrl));
    expect(message).toContain('Refusing to connect');
    expect(message).toContain(fp(SELF_SIGNED));
    expect(message).toContain(fp(OTHER));
    // A CA-valid certificate is refused too: the pin is exact
    expect(await failure(createTrustedFetch({ fingerprint: fp(OTHER) })(caSignedUrl))).toContain('Refusing to connect');
  });

  it('trusts the self-signed certificate from a PEM under any host name', async () => {
    const trusted = createTrustedFetch({ certificatePem: SELF_SIGNED });
    expect((await trusted(selfSignedUrl)).status).toBe(200);
  });

  it('trusts certificates issued by a CA from a PEM, with the normal host name check', async () => {
    const trusted = createTrustedFetch({ certificatePem: CA });
    expect((await trusted(caSignedUrl)).status).toBe(200);
    expect(await failure(trusted(caSignedUrl.replace('127.0.0.1', 'localhost')))).toMatch(/localhost/);
    expect(await failure(trusted(selfSignedUrl))).toMatch(/self[- ]signed/i);
  });

  it('applies the pin on top of a PEM', async () => {
    expect((await createTrustedFetch({ certificatePem: CA, fingerprint: fp(read('leaf.pem')) })(caSignedUrl)).status).toBe(200);
    expect(await failure(createTrustedFetch({ certificatePem: SELF_SIGNED, fingerprint: fp(OTHER) })(selfSignedUrl))).toContain('Refusing to connect');
  });
});

describe('HomebridgeClient certificate options', () => {
  it('reaches a self-signed Homebridge UI pinned by fingerprint', async () => {
    const client = new HomebridgeClient({ url: selfSignedUrl, token: 'hbg_x', certFingerprint: fp(SELF_SIGNED) });
    expect(await client.getHomebridgeStatus()).toEqual({ ok: true });
  });

  it('reads the certificate from HOMEBRIDGE_CERT_PATH and HOMEBRIDGE_CERT_FINGERPRINT', async () => {
    vi.stubEnv('HOMEBRIDGE_CERT_PATH', fixture('self-signed.pem'));
    expect(await new HomebridgeClient({ url: selfSignedUrl, token: 'hbg_x' }).getHomebridgeStatus()).toEqual({ ok: true });
    vi.stubEnv('HOMEBRIDGE_CERT_PATH', '');
    vi.stubEnv('HOMEBRIDGE_CERT_FINGERPRINT', fp(OTHER));
    const client = new HomebridgeClient({ url: selfSignedUrl, token: 'hbg_x' });
    await expect(client.getHomebridgeStatus()).rejects.toThrow(
      /Cannot reach Homebridge at https:\/\/127\.0\.0\.1:\d+ \(GET \/api\/status\/homebridge\): Refusing to connect/,
    );
  });

  it('prefers an explicit fetch', async () => {
    const custom = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    const client = new HomebridgeClient({ url: selfSignedUrl, token: 'hbg_x', certFingerprint: 'not checked', fetch: custom });
    await client.getHomebridgeStatus();
    expect(custom).toHaveBeenCalled();
  });

  it('reports bad certificate settings at construction', () => {
    expect(() => new HomebridgeClient({ url: plainUrl, token: 'x', certFingerprint: fp(OTHER) })).toThrow('only apply to an https HOMEBRIDGE_URL');
    expect(() => new HomebridgeClient({ url: selfSignedUrl, token: 'x', certFingerprint: 'abc' })).toThrow(
      'Cannot trust the Homebridge UI certificate: The certificate fingerprint must be a SHA-256 fingerprint',
    );
    expect(() => new HomebridgeClient({ url: selfSignedUrl, token: 'x', certPath: '/nonexistent/cert.pem' })).toThrow(
      'Cannot read the certificate file HOMEBRIDGE_CERT_PATH (/nonexistent/cert.pem)',
    );
    expect(() => new HomebridgeClient({ url: selfSignedUrl, token: 'x', certPath: fixture('self-signed.key') })).toThrow('no PEM certificate found');
  });
});
