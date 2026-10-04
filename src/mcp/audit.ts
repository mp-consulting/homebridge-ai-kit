/**
 * Append-only audit log of write tool calls, one JSON object per line. The
 * file rotates by size (`audit.jsonl` → `audit.jsonl.1` → … → `.keep`).
 */

import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Scope } from './scopes.js';

export interface AuditEntry {
  /** ISO 8601 time the call finished. */
  ts: string;
  tool: string;
  /** Arguments with secrets redacted. */
  args: unknown;
  ok: boolean;
  /** The error text when `ok` is false. */
  error?: string;
  /** MCP session id (HTTP). */
  session?: string;
  /** The MCP client's self-reported name and version. */
  client?: string;
  /** Which configured token was used, e.g. `default` or a client's name. */
  principal?: string;
  scope?: Scope;
}

export interface AuditSink {
  record(entry: AuditEntry): void | Promise<void>;
}

export interface AuditLogOptions {
  path: string;
  /** Rotate once the file would grow past this. Default 5 MiB. */
  maxBytes?: number;
  /** Rotated files kept. Default 3. */
  keep?: number;
  /** Called when a write fails; the call being audited is not affected. */
  onError?: (error: Error) => void;
}

export interface AuditLog extends AuditSink {
  readonly path: string;
  record(entry: AuditEntry): Promise<void>;
  /** Settles once every queued entry is written. */
  flush(): Promise<void>;
}

export const DEFAULT_AUDIT_MAX_BYTES = 5 * 1024 * 1024;
export const AUDIT_LOG_FILE = 'homebridge-ai-kit-audit.jsonl';

/** Default location: `$UIX_STORAGE_PATH`, else `~/.homebridge`, joined with {@link AUDIT_LOG_FILE}. */
export function defaultAuditLogPath(storagePath?: string): string {
  return join(storagePath || process.env.UIX_STORAGE_PATH || join(homedir(), '.homebridge'), AUDIT_LOG_FILE);
}

export function createAuditLog(options: AuditLogOptions): AuditLog {
  const { path } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_AUDIT_MAX_BYTES;
  const keep = Math.max(1, options.keep ?? 3);
  let queue: Promise<void> = Promise.resolve();
  let dirReady = false;

  const rotate = async () => {
    await rm(`${path}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      await rename(`${path}.${i}`, `${path}.${i + 1}`).catch(() => undefined);
    }
    await rename(path, `${path}.1`);
  };

  const write = async (line: string) => {
    if (!dirReady) {
      await mkdir(dirname(path), { recursive: true });
      dirReady = true;
    }
    const size = await stat(path).then(
      (s) => s.size,
      () => 0,
    );
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
      await rotate();
    }
    await appendFile(path, line, { mode: 0o600 });
  };

  return {
    path,
    record(entry) {
      const line = `${JSON.stringify(entry)}\n`;
      queue = queue.then(() =>
        write(line).catch((error: unknown) => {
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
        }),
      );
      return queue;
    },
    flush() {
      return queue;
    },
  };
}
