import { describe, it, expect } from 'vitest';
import { errorMessage, handle, jsonResult, pick } from '../../src/tools/helpers.js';

describe('tool helpers', () => {
  it('errorMessage uses the message of an Error and stringifies anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });

  it('handle turns a thrown value into an isError result', async () => {
    const wrapped = handle('doing things', async () => {
      throw 'nope';
    });
    await expect(wrapped()).resolves.toEqual({
      content: [{ type: 'text', text: 'Error doing things: nope' }],
      isError: true,
    });
  });

  it('jsonResult emits compact JSON', () => {
    expect(jsonResult({ a: [1, 2] }).content).toEqual([{ type: 'text', text: '{"a":[1,2]}' }]);
  });

  it('pick copies only keys that are present', () => {
    expect(pick({ a: 1, b: undefined, c: 3 }, ['a', 'b', 'd'])).toEqual({ a: 1, b: undefined });
  });
});
