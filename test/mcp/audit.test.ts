import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_LOG_FILE, createAuditLog, defaultAuditLogPath } from '../../src/mcp/audit.js';
import type { AuditEntry } from '../../src/mcp/audit.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ai-kit-audit-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const entry = (tool: string): AuditEntry => ({ ts: '2026-10-04T00:00:00.000Z', tool, args: {}, ok: true });

describe('createAuditLog', () => {
  it('appends one JSON object per line, creating the directory', async () => {
    const path = join(dir, 'nested', 'audit.jsonl');
    const log = createAuditLog({ path });
    void log.record(entry('a'));
    await log.record(entry('b'));
    await log.flush();
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.tool)).toEqual(['a', 'b']);
    expect(log.path).toBe(path);
  });

  it('rotates by size and keeps a bounded number of old files', async () => {
    const path = join(dir, 'audit.jsonl');
    const lineBytes = JSON.stringify(entry('x')).length + 1;
    const log = createAuditLog({ path, maxBytes: lineBytes * 2, keep: 2 });
    for (let i = 0; i < 9; i++) {
      await log.record(entry('x'));
    }
    expect((await readdir(dir)).sort()).toEqual(['audit.jsonl', 'audit.jsonl.1', 'audit.jsonl.2']);
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect((await readFile(`${path}.1`, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('reports write errors without throwing', async () => {
    const blocker = join(dir, 'file');
    await writeFile(blocker, '');
    const onError = vi.fn();
    const log = createAuditLog({ path: join(blocker, 'audit.jsonl'), onError });
    await expect(log.record(entry('a'))).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    await expect(createAuditLog({ path: join(blocker, 'x') }).record(entry('a'))).resolves.toBeUndefined();
  });
});

describe('defaultAuditLogPath', () => {
  it('uses the given storage path, else UIX_STORAGE_PATH, else ~/.homebridge', () => {
    expect(defaultAuditLogPath('/srv/hb')).toBe(join('/srv/hb', AUDIT_LOG_FILE));
    vi.stubEnv('UIX_STORAGE_PATH', '/var/lib/homebridge');
    expect(defaultAuditLogPath()).toBe(join('/var/lib/homebridge', AUDIT_LOG_FILE));
    vi.stubEnv('UIX_STORAGE_PATH', '');
    expect(defaultAuditLogPath()).toMatch(/\.homebridge[/\\]homebridge-ai-kit-audit\.jsonl$/);
  });
});
