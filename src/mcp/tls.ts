/**
 * Trusting a Homebridge UI served over HTTPS with a self-signed certificate,
 * without turning off certificate verification for anything else: the fetch
 * built here is handed to HomebridgeClient only. Global fetch, the providers
 * and every other connection keep Node's normal verification.
 */

import { X509Certificate } from 'node:crypto';
import type { PeerCertificate, TLSSocket } from 'node:tls';
import { checkServerIdentity, rootCertificates } from 'node:tls';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';

export interface TrustOptions {
  /**
   * SHA-256 fingerprint of the certificate the server must present, as
   * `openssl x509 -noout -fingerprint -sha256` prints it (colons and case don't matter).
   */
  fingerprint?: string;
  /** PEM certificate(s) to trust in addition to the public roots: the server's own (self-signed) certificate or the CA that issued it. */
  certificatePem?: string;
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * `AB:CD:…` (64 hex digits, upper case) as Node reports `fingerprint256`.
 * Accepts colons, spaces, any case and an `sha256` / `SHA256 Fingerprint=` prefix.
 */
export function normalizeFingerprint(value: string): string {
  const hex = value
    .trim()
    .replace(/^sha-?256(\s*fingerprint)?\s*[=:/]?\s*/i, '')
    .replace(/[\s:]/g, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`The certificate fingerprint must be a SHA-256 fingerprint (64 hex digits, colons optional), got "${value}"`);
  }
  return hex.toUpperCase().match(/../g)!.join(':');
}

/** The SHA-256 fingerprints of every certificate in a PEM file. Throws when it holds none. */
export function pemFingerprints(pem: string): string[] {
  const blocks = pem.match(PEM_BLOCK);
  if (!blocks) {
    throw new Error('no PEM certificate found');
  }
  return blocks.map((block) => new X509Certificate(block).fingerprint256);
}

/** A peer certificate's fingerprint; undefined when the server sent none. */
function peerFingerprint(peer: PeerCertificate): string | undefined {
  return peer.fingerprint256 || undefined;
}

function mismatch(host: string, actual: string | undefined, expected: string): Error {
  return new Error(
    `Refusing to connect: the certificate presented by ${host} has SHA-256 fingerprint ${actual ?? '(none)'}, not the pinned ${expected}. ` +
      'If the Homebridge UI certificate was renewed, update the configured fingerprint.',
  );
}

/**
 * The undici connect option for `options`.
 *
 * - With a PEM: the chain must validate against the public roots plus that PEM.
 *   When a fingerprint is also set, the leaf must match it; otherwise a leaf
 *   that is itself in the PEM (a self-signed certificate) is accepted under any
 *   host name, and any other leaf goes through the normal host name check.
 * - With only a fingerprint: the leaf must match it exactly (certificate
 *   pinning), checked once the handshake is done and before any request is sent.
 */
function connectOption(options: TrustOptions): ConstructorParameters<typeof Agent>[0] {
  const expected = options.fingerprint ? normalizeFingerprint(options.fingerprint) : undefined;
  if (options.certificatePem) {
    const pem = options.certificatePem;
    const trusted = new Set(pemFingerprints(pem));
    return {
      connect: {
        ca: [...rootCertificates, pem],
        checkServerIdentity: (host, peer) => {
          const actual = peerFingerprint(peer);
          if (expected) {
            return actual === expected ? undefined : mismatch(host, actual, expected);
          }
          return actual && trusted.has(actual) ? undefined : checkServerIdentity(host, peer);
        },
      },
    };
  }
  if (!expected) {
    throw new Error('Set a certificate fingerprint or a certificate file to trust');
  }
  // The chain of a self-signed certificate can't validate, so it is not
  // required to: the exact leaf is, which is stricter. No TLS session reuse,
  // so every connection presents its certificate.
  const base = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
  return {
    connect: (opts, callback) => {
      base(opts, (error, socket) => {
        if (error) {
          callback(error, null);
          return;
        }
        if (opts.protocol === 'https:') {
          const actual = peerFingerprint((socket as TLSSocket).getPeerCertificate());
          if (actual !== expected) {
            socket.destroy();
            callback(mismatch(opts.hostname, actual, expected), null);
            return;
          }
        }
        callback(null, socket);
      });
    },
  };
}

/**
 * A fetch that trusts the given certificate (by fingerprint and/or PEM) on
 * top of Node's defaults. Only requests made with it are affected.
 */
export function createTrustedFetch(options: TrustOptions): typeof fetch {
  const agent = new Agent(connectOption(options));
  const trustedFetch = (input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(input, { ...init, dispatcher: agent });
  return trustedFetch as unknown as typeof fetch;
}
