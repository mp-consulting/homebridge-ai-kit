import { describe, expect, it } from 'vitest';
import { atLeast, parseLogLines, parseLogTimestamp, parseTimeBound } from '../../src/mcp/log-parse.js';

const ESC = '\u001B';
const line = (ts: string, prefix: string, msg: string, colour?: number) =>
  `${ESC}[37m[${ts}]${ESC}[39m ${ESC}[36m[${prefix}]${ESC}[39m ${colour ? `${ESC}[${colour}m${msg}${ESC}[39m` : msg}`;

describe('parseLogTimestamp', () => {
  it.each([
    ['10/4/2026, 8:05:09 PM', new Date(2026, 9, 4, 20, 5, 9)],
    ['10/4/2026, 12:05:09 AM', new Date(2026, 9, 4, 0, 5, 9)],
    ['10/4/2026, 12:05:09 PM', new Date(2026, 9, 4, 12, 5, 9)],
    ['25/12/2026, 20:00:00', new Date(2026, 11, 25, 20, 0, 0)],
    ['4.10.2026, 20:00:00', new Date(2026, 9, 4, 20, 0, 0)],
    ['10/4/26 8:05 PM', new Date(2026, 9, 4, 20, 5, 0)],
    ['2026-10-04 20:00:01', new Date(2026, 9, 4, 20, 0, 1)],
    ['2026-10-04T20:00', new Date(2026, 9, 4, 20, 0, 0)],
    ['Sun Oct 04 2026 20:00:00', new Date(2026, 9, 4, 20, 0, 0)],
  ])('reads %s', (input, expected) => {
    expect(parseLogTimestamp(input)).toBe(expected.getTime());
  });

  it('gives up on something else', () => {
    expect(parseLogTimestamp('Homebridge UI')).toBeUndefined();
  });
});

describe('parseLogLines', () => {
  it('reads time, prefix and level from colours', () => {
    const entries = parseLogLines([
      line('10/4/2026, 8:00:00 PM', 'Hue', 'connected'),
      line('10/4/2026, 8:00:01 PM', 'Hue', 'slow bridge', 33),
      line('10/4/2026, 8:00:02 PM', 'Ring', 'socket closed', 31),
      `${ESC}[31m    at Socket.emit (node:events:1)${ESC}[39m`,
      '    at more frames',
      line('10/4/2026, 8:00:03 PM', 'Hue', 'raw packet', 90),
      '',
    ]);
    expect(entries.map((e) => [e.level, e.prefix])).toEqual([
      ['info', 'Hue'],
      ['warn', 'Hue'],
      ['error', 'Ring'],
      ['error', 'Ring'],
      ['error', 'Ring'],
      ['debug', 'Hue'],
      ['debug', 'Hue'],
    ]);
    expect(entries[0].text).toBe('[10/4/2026, 8:00:00 PM] [Hue] connected');
    expect(entries[4].time).toBe(new Date(2026, 9, 4, 20, 0, 2).getTime());
  });

  it('falls back to the words without colours', () => {
    const entries = parseLogLines([
      '[10/4/2026, 8:00:00 PM] [A] Error: unreachable',
      '[10/4/2026, 8:00:00 PM] [A] Warning: deprecated option',
      '[10/4/2026, 8:00:00 PM] [A] [debug] packet',
      '[10/4/2026, 8:00:00 PM] no prefix here',
      'no timestamp at all',
    ]);
    expect(entries.map((e) => e.level)).toEqual(['error', 'warn', 'debug', 'info', 'info']);
    expect(entries[3].prefix).toBeUndefined();
    expect(entries[4].time).toBe(entries[3].time);
  });
});

describe('parseTimeBound', () => {
  const now = Date.UTC(2026, 9, 4, 12);
  it('reads durations and ISO times', () => {
    expect(parseTimeBound('1h', now)).toBe(now - 3_600_000);
    expect(parseTimeBound('30m', now)).toBe(now - 1_800_000);
    expect(parseTimeBound('2d ago', now)).toBe(now - 172_800_000);
    expect(parseTimeBound('1.5 h', now)).toBe(now - 5_400_000);
    expect(parseTimeBound('2026-10-04T10:00:00Z', now)).toBe(Date.UTC(2026, 9, 4, 10));
  });

  it('explains a bad value', () => {
    expect(() => parseTimeBound('yesterday-ish')).toThrow('Cannot read the time "yesterday-ish"');
  });
});

describe('atLeast', () => {
  it('orders levels', () => {
    expect(atLeast('error', 'warn')).toBe(true);
    expect(atLeast('info', 'warn')).toBe(false);
    expect(atLeast('debug', 'debug')).toBe(true);
  });
});
