import { describe, expect, it } from 'vitest';
import { diffJson, unifiedJsonDiff } from '../../src/mcp/config-diff.js';

describe('diffJson', () => {
  it('lists added, removed and changed paths', () => {
    const before = { bridge: { name: 'A', port: 1 }, platforms: [{ platform: 'X' }, { platform: 'Y' }], 'odd key': 1 };
    const after = { bridge: { name: 'B', pin: '1' }, platforms: [{ platform: 'X', extra: true }], 'odd key': 2 };
    expect(diffJson(before, after)).toEqual([
      { path: 'bridge.name', op: 'change', before: 'A', after: 'B' },
      { path: 'bridge.port', op: 'remove', before: 1 },
      { path: 'bridge.pin', op: 'add', after: '1' },
      { path: 'platforms[0].extra', op: 'add', after: true },
      { path: 'platforms[1]', op: 'remove', before: { platform: 'Y' } },
      { path: '$["odd key"]', op: 'change', before: 1, after: 2 },
    ]);
  });

  it('reports a type change as one change and grown arrays as adds', () => {
    expect(diffJson({ a: [1] }, { a: { x: 1 } })).toEqual([{ path: 'a', op: 'change', before: [1], after: { x: 1 } }]);
    expect(diffJson([1], [1, 2])).toEqual([{ path: '$[1]', op: 'add', after: 2 }]);
    expect(diffJson({ a: 1 }, { a: 1 })).toEqual([]);
  });
});

describe('unifiedJsonDiff', () => {
  it('is empty for equal values', () => {
    expect(unifiedJsonDiff({ a: 1 }, { a: 1 })).toBe('');
  });

  it('produces hunks with context and line numbers', () => {
    const before = { list: Array.from({ length: 20 }, (_, i) => i) };
    const after = { list: before.list.map((n) => (n === 2 || n === 17 ? n * 100 : n)) };
    const diff = unifiedJsonDiff(before, after, { context: 1 }).split('\n');
    expect(diff[0]).toBe('--- config.json (current)');
    expect(diff[1]).toBe('+++ config.json (proposed)');
    expect(diff.filter((l) => l.startsWith('@@'))).toEqual(['@@ -4,3 +4,3 @@', '@@ -19,3 +19,3 @@']);
    expect(diff).toContain('-    2,');
    expect(diff).toContain('+    200,');
  });

  it('handles pure insertions and deletions', () => {
    expect(unifiedJsonDiff({}, { a: 1 })).toContain('+  "a": 1');
    const removed = unifiedJsonDiff({ a: 1, b: 2 }, { a: 1 });
    expect(removed).toContain('-  "b": 2');
    expect(removed).toContain('-  "a": 1,');
    expect(removed).toContain('+  "a": 1');
  });

  it('falls back to one replaced block for very large changes', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `a${i}`);
    const after = Array.from({ length: 2000 }, (_, i) => `b${i}`);
    const diff = unifiedJsonDiff(before, after, { context: 0 });
    expect(diff.split('\n').filter((l) => l.startsWith('-  "a')).length).toBe(2000);
    expect(diff.split('\n').filter((l) => l.startsWith('+  "b')).length).toBe(2000);
  });
});
