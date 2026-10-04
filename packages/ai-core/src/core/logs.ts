/** Reading the end of a log file and cleaning terminal escape codes out of log text. */

import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';

/** ANSI CSI escape sequences: colours (`ESC[31m`), cursor and erase codes (`ESC[2K`, `ESC[1G`). */
// eslint-disable-next-line no-control-regex
export const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

/** `text` without ANSI escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export interface TailOptions {
  /** Drop the first line, which is partial when `text` starts mid-file. */
  dropFirst?: boolean;
  /** Keep blank lines (default false). */
  keepBlank?: boolean;
}

/** The last `maxLines` lines of `text`, ANSI-stripped. */
export function tailLines(text: string, maxLines: number, options: TailOptions = {}): string[] {
  const lines = stripAnsi(text).split(/\r?\n/);
  if (options.dropFirst) {
    lines.shift();
  }
  const kept = options.keepBlank ? lines : lines.filter((line) => line.trim() !== '');
  return maxLines > 0 ? kept.slice(-maxLines) : [];
}

/**
 * The last `maxLines` non-blank lines of a log file, read from at most its
 * last `maxBytes` bytes, without ANSI codes. The first (probably partial)
 * line of the window is dropped when the file is longer than the window.
 */
export async function readLogTail(path: string, maxBytes: number, maxLines: number): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.max(0, Math.min(size, maxBytes));
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return tailLines(buffer.toString('utf8'), maxLines, { dropFirst: size > length });
  } finally {
    await handle.close();
  }
}
