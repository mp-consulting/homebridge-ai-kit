/**
 * Parsing of Homebridge log lines: `[<date>] [<prefix>] <message>`, where the
 * date is the server's `toLocaleString()` and the level is only visible in the
 * colour (Homebridge's logger paints warnings yellow, errors red, debug grey).
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  /** The line, ANSI-stripped. */
  text: string;
  /** Epoch ms from the line's timestamp, or inherited from the line above (stack traces, wrapped output). */
  time?: number;
  level: LogLevel;
  /** The plugin/platform prefix, e.g. `Hue` from `[Hue]`. */
  prefix?: string;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[([0-9;]*)m/g;

const LINE = /^\[([^\]]{6,40})\]\s+(?:\[([^\]]+)\]\s*)?/;

/** Level from the colour codes Homebridge's logger writes (chalk red/yellow/grey), if any. */
function levelFromColour(raw: string): LogLevel | undefined {
  const codes = [...raw.matchAll(ANSI)].flatMap((m) => m[1].split(';'));
  if (codes.includes('31') || codes.includes('91')) {
    return 'error';
  }
  if (codes.includes('33') || codes.includes('93')) {
    return 'warn';
  }
  if (codes.includes('90') || codes.includes('2')) {
    return 'debug';
  }
  return undefined;
}

/** Level from the words in the message, for logs without colour. */
function levelFromText(message: string): LogLevel {
  if (/\b(error|exception|fatal|failed|unhandled)\b|\[E\]/i.test(message)) {
    return 'error';
  }
  if (/\b(warn|warning|deprecated)\b|\[W\]/i.test(message)) {
    return 'warn';
  }
  if (/\[debug\]|\bdebug:/i.test(message)) {
    return 'debug';
  }
  return 'info';
}

/**
 * A Homebridge timestamp in local time: `10/4/2026, 8:00:00 PM` (en-US),
 * `04/10/2026, 20:00:00` (day first when the first number can't be a month),
 * `4.10.2026, 20:00:00` (de), `2026-10-04 20:00:00` (ISO-ish). Undefined if unparseable.
 */
export function parseLogTimestamp(s: string): number | undefined {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, se] = iso.map(Number);
    return new Date(y, mo - 1, d, h, mi, se || 0).getTime();
  }
  const local = /^(\d{1,2})([/.])(\d{1,2})\2(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/.exec(s);
  if (local) {
    const [, a, sep, b, yy, hh, mi, se, ampm] = local;
    let day = Number(b);
    let month = Number(a);
    if (sep === '.' || month > 12) {
      [day, month] = [month, day];
    }
    let hour = Number(hh) % (ampm ? 12 : 24);
    if (ampm && /p/i.test(ampm)) {
      hour += 12;
    }
    const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
    return new Date(year, month - 1, day, hour, Number(mi), Number(se ?? 0)).getTime();
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Parses raw (possibly coloured) log lines. Lines without a timestamp inherit time, prefix and level from the line above. */
export function parseLogLines(raw: string[]): LogEntry[] {
  let last: Omit<LogEntry, 'text'> = { level: 'info' };
  return raw.map((line) => {
    const text = line.replace(ANSI, '');
    const m = LINE.exec(text);
    const time = m ? parseLogTimestamp(m[1]) : undefined;
    if (m && time !== undefined) {
      const message = text.slice(m[0].length);
      last = { time, prefix: m[2], level: levelFromColour(line) ?? levelFromText(message) };
    } else if (text.trim() !== '') {
      // A continuation keeps the entry's level unless it shows its own colour.
      const own = levelFromColour(line);
      return { text, ...last, ...(own ? { level: own } : {}) };
    }
    return { text, ...last };
  });
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `since`/`until`: an ISO date/time, or a duration back from now such as `30m`, `1h`, `2d`. */
export function parseTimeBound(input: string, now = Date.now()): number {
  const rel = /^\s*(\d+(?:\.\d+)?)\s*([smhdw])\s*(?:ago)?\s*$/i.exec(input);
  if (rel) {
    return now - Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()];
  }
  const t = Date.parse(input);
  if (Number.isNaN(t)) {
    throw new Error(`Cannot read the time "${input}": use an ISO date like 2026-10-04T18:00 or a duration like 30m, 1h, 2d.`);
  }
  return t;
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** True when `level` is at least `min` (error > warn > info > debug). */
export function atLeast(level: LogLevel, min: LogLevel): boolean {
  return RANK[level] >= RANK[min];
}
