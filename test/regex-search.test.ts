import { describe, it, expect } from 'vitest';
import { RegexTimeoutError, regexSearch } from '../src/regex-search.js';

describe('regexSearch', () => {
  it('returns the indices of matching lines', async () => {
    await expect(regexSearch(['alpha', 'beta', 'ALPHA'], '^alpha$', 'i', 2000)).resolves.toEqual([0, 2]);
  });

  it('respects case-sensitive flags', async () => {
    await expect(regexSearch(['alpha', 'ALPHA'], 'alpha', '', 2000)).resolves.toEqual([0]);
  });

  it('rejects with RegexTimeoutError when the budget runs out', async () => {
    const started = Date.now();
    await expect(regexSearch([`${'a'.repeat(40)}!`], '^(a+)+$', '', 200)).rejects.toBeInstanceOf(RegexTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects when the worker fails, e.g. on an invalid pattern', async () => {
    await expect(regexSearch(['x'], '(unclosed', '', 2000)).rejects.toThrow(SyntaxError);
  });
});
