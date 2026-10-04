/** A {@link UsageStore} that keeps the usage snapshot in a JSON file. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UsageSnapshot, UsageStore } from './usage.js';

/**
 * Reads and writes a {@link UsageSnapshot} as JSON at `path`. Writes go to a
 * temporary file that is renamed over the old one, so a crash never leaves a
 * half-written file. A missing file loads as empty.
 */
export class JsonFileUsageStore implements UsageStore {
  constructor(readonly path: string) {}

  async load(): Promise<UsageSnapshot | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
    try {
      return JSON.parse(raw) as UsageSnapshot;
    } catch (error) {
      throw new Error(`Cannot parse the AI usage file ${this.path}: ${(error as Error).message}`, { cause: error });
    }
  }

  async save(snapshot: UsageSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
