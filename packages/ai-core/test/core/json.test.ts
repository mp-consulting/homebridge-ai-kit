import { describe, expect, it, vi } from 'vitest';
import { JsonGenerationError, extractJson, generateJson, normalizePluginSchema } from '../../src/core/json.js';
import { fakeProvider } from '../providers/helpers.js';

const schema = { type: 'object', required: ['risk'], properties: { risk: { enum: ['low', 'high'] } } };

describe('extractJson', () => {
  it('parses plain, fenced and embedded JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Sure! {"a":3} hope that helps')).toEqual({ a: 3 });
    expect(extractJson('list: [1,2]')).toEqual([1, 2]);
  });

  it('explains failures', () => {
    expect(() => extractJson('no json here')).toThrow('contains no JSON');
    expect(() => extractJson('broken {"a": } end')).toThrow('not valid JSON');
  });
});

describe('generateJson', () => {
  it('returns validated data on the first try', async () => {
    const { provider, requests } = fakeProvider([{ text: '{"risk":"low"}' }]);
    const result = await generateJson<{ risk: string }>({ provider, schema, prompt: 'assess' });
    expect(result.data).toEqual({ risk: 'low' });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(requests[0].system).toContain('JSON Schema');
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'assess' }]);
  });

  it('asks once more with the validation errors', async () => {
    const { provider, requests } = fakeProvider([{ text: '{"risk":"medium"}' }, { text: '```json\n{"risk":"high"}\n```' }]);
    const onChunk = vi.fn();
    const result = await generateJson({ provider, schema, prompt: 'p', system: 'custom', onChunk });
    expect(result.data).toEqual({ risk: 'high' });
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(requests[1].system?.startsWith('custom')).toBe(true);
    expect(requests[1].messages[1]).toEqual({ role: 'assistant', content: '{"risk":"medium"}' });
    expect(requests[1].messages[2].content).toContain('/risk must be equal to one of the allowed values');
    expect(onChunk).toHaveBeenCalled();
  });

  it('gives up after the repair attempt', async () => {
    const { provider, requests } = fakeProvider([{ text: '' }, { text: 'still not json' }]);
    const error = await generateJson({ provider, schema, prompt: 'p' }).catch((e) => e);
    expect(error).toBeInstanceOf(JsonGenerationError);
    expect(error.errors).toEqual(['the reply contains no JSON']);
    expect(error.text).toBe('still not json');
    expect(requests[1].messages[1]).toEqual({ role: 'assistant', content: '(empty reply)' });
  });

  it('does not retry a reply cut off at the output limit', async () => {
    const { provider, requests } = fakeProvider([{ text: '{"risk":"lo', stopReason: 'max_tokens' }]);
    const error = await generateJson({ provider, schema, prompt: 'p', maxOutputTokens: 2048 }).catch((e) => e);
    expect(error).toBeInstanceOf(JsonGenerationError);
    expect(error.message).toBe('The answer was cut off at the 2048-token output limit. Raise the maximum answer length, or ask for less at once.');
    expect(error.text).toBe('{"risk":"lo');
    expect(requests).toHaveLength(1);
  });

  it('names the provider limit when no maximum was given', async () => {
    const { provider } = fakeProvider([{ text: '{', stopReason: 'max_tokens' }]);
    await expect(generateJson({ provider, schema, prompt: 'p' })).rejects.toThrow('cut off at its output limit');
  });

  it('accepts valid JSON even when the reply stopped at the limit', async () => {
    const { provider } = fakeProvider([{ text: '{"risk":"low"}', stopReason: 'max_tokens' }]);
    await expect(generateJson({ provider, schema, prompt: 'p' })).resolves.toMatchObject({ data: { risk: 'low' } });
  });

    it('reports a missing required key', async () => {
    const { provider } = fakeProvider([{ text: '[]' }, { text: '{}' }]);
    await expect(generateJson({ provider, schema, prompt: 'p' })).rejects.toThrow("(root) must have required property 'risk'");
  });
});

describe('normalizePluginSchema', () => {
  it('turns Homebridge-style required flags into standard JSON Schema', () => {
    expect(
      normalizePluginSchema({
        type: 'object',
        required: ['a'],
        properties: {
          a: { type: 'string', required: true, placeholder: 'x' },
          b: { type: 'integer', required: false, condition: { functionBody: 'return true' } },
          c: { type: 'array', items: { type: 'object', properties: { d: { type: 'string', required: true } } } },
          placeholder: { type: 'string' },
        },
      }),
    ).toEqual({
      type: 'object',
      required: ['a'],
      properties: {
        a: { type: 'string' },
        b: { type: 'integer' },
        c: { type: 'array', items: { type: 'object', properties: { d: { type: 'string' } }, required: ['d'] } },
        placeholder: { type: 'string' },
      },
    });
  });

  it('keeps a required array that comes after properties without flags', () => {
    expect(normalizePluginSchema({ properties: { a: {} }, required: ['a'] })).toEqual({ properties: { a: {} }, required: ['a'] });
    expect(normalizePluginSchema({ properties: { a: {} } })).toEqual({ properties: { a: {} } });
    expect(normalizePluginSchema([{ required: true }])).toEqual([{}]);
    expect(normalizePluginSchema(null)).toBeNull();
  });
});
