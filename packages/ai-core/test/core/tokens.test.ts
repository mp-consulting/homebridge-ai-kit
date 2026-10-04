import { describe, expect, it } from 'vitest';
import { estimateTokens, inputBudget, trimToContext } from '../../src/core/tokens.js';

describe('tokens', () => {
  it('estimates ~4 characters per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('leaves short text alone', () => {
    expect(trimToContext('short', 10)).toBe('short');
  });

  it('keeps the tail on a line boundary by default', () => {
    const text = ['line one', 'line two', 'line three', 'line four'].join('\n');
    const out = trimToContext(text, 5);
    expect(out).toMatch(/^\[… \d+ earlier characters trimmed\]\n/);
    expect(out.endsWith('line four')).toBe(true);
    expect(out).not.toContain('line one');
  });

  it('keeps the head when asked', () => {
    const text = ['alpha', 'beta', 'gamma', 'delta'].join('\n');
    const out = trimToContext(text, 3, { keep: 'head' });
    expect(out.startsWith('alpha')).toBe(true);
    expect(out).toMatch(/\[… \d+ later characters trimmed\]$/);
  });

  it('cuts mid-line when there is no newline', () => {
    expect(trimToContext('x'.repeat(100), 2)).toBe(`[… 92 earlier characters trimmed]\n${'x'.repeat(8)}`);
    expect(trimToContext('y'.repeat(100), 2, { keep: 'head' })).toBe(`${'y'.repeat(8)}\n[… 92 later characters trimmed]`);
  });

  it('computes an input budget with a floor and a cap', () => {
    expect(inputBudget(100_000, 2000)).toBe(96_976);
    expect(inputBudget(100_000, 2000, 10_000)).toBe(10_000);
    expect(inputBudget(4096, 4000)).toBe(256);
  });
});
