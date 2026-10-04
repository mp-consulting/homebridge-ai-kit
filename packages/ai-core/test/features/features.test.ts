import { describe, expect, it, vi } from 'vitest';
import {
  ask,
  assessPluginUpdate,
  dailyDigest,
  diagnoseLogs,
  explainDeviceError,
  generatePluginConfig,
  suggestOrganization,
} from '../../src/features/index.js';
import { REDACTED } from '../../src/core/redaction.js';
import { fakeProvider } from '../providers/helpers.js';

function userText(req: { messages: Array<{ content: unknown }> }, i = 0): string {
  return req.messages[i].content as string;
}

describe('diagnoseLogs', () => {
  it('redacts, trims to the budget and streams', async () => {
    const { provider, requests } = fakeProvider([{ text: 'All good' }], { contextTokens: 4000 });
    const onChunk = vi.fn();
    const logs = ['[hue] password=hunter2', ...Array.from({ length: 2000 }, (_, i) => `line ${i}`)];
    const result = await diagnoseLogs({ provider, logs, focus: 'hue', onChunk, systemContext: 'ctx' });
    expect(result).toEqual({ text: 'All good', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(onChunk).toHaveBeenCalled();
    const sent = userText(requests[0]);
    expect(sent).not.toContain('hunter2');
    expect(sent).toContain('earlier characters trimmed');
    expect(sent).toContain('line 1999');
    expect(requests[0].system).toMatch(/ctx$/);
  });

  it('accepts a single string', async () => {
    const { provider, requests } = fakeProvider([{ text: 'x' }]);
    await diagnoseLogs({ provider, logs: 'token: abc' });
    expect(userText(requests[0])).toContain(`token: ${REDACTED}`);
  });
});

describe('generatePluginConfig', () => {
  const schema = {
    pluginAlias: 'Demo',
    schema: { type: 'object', properties: { name: { type: 'string', required: true }, password: { type: 'string' }, port: { type: 'integer' } } },
  };

  it('validates against the plugin schema and restores redacted secrets', async () => {
    const { provider, requests } = fakeProvider([{ text: JSON.stringify({ config: { name: 'Demo', password: REDACTED, port: 80 }, explanation: 'Set the port.' }) }]);
    const result = await generatePluginConfig({ provider, schema, request: 'use port 80', current: { name: 'Demo', password: 's3cret' }, pluginName: 'demo' });
    expect(result.config).toEqual({ name: 'Demo', password: 's3cret', port: 80 });
    expect(result.explanation).toBe('Set the port.');
    expect(userText(requests[0])).not.toContain('s3cret');
  });

  it('retries when the config breaks the schema', async () => {
    const { provider } = fakeProvider([
      { text: JSON.stringify({ config: { port: 80 }, explanation: 'x' }) },
      { text: JSON.stringify({ config: { name: 'A', port: 80 }, explanation: 'fixed' }) },
    ]);
    const result = await generatePluginConfig({ provider, schema: schema.schema, request: 'r' });
    expect(result.config).toEqual({ name: 'A', port: 80 });
  });

  it('leaves a placeholder it cannot restore', async () => {
    const { provider } = fakeProvider([{ text: JSON.stringify({ config: { name: 'A', password: REDACTED }, explanation: 'x' }) }]);
    const result = await generatePluginConfig({ provider, schema, request: 'r', current: { name: 'B' } });
    expect(result.config.password).toBe(REDACTED);
  });

  it('rethrows unexpected restore errors', async () => {
    const { provider } = fakeProvider([{ text: JSON.stringify({ config: { name: 'A', password: REDACTED }, explanation: 'x' }) }]);
    const current = { name: 'B' };
    Object.defineProperty(current, 'password', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    await expect(generatePluginConfig({ provider, schema, request: 'r', current })).rejects.toThrow('boom');
  });
});

describe('explainDeviceError', () => {
  it('sends the error, device and context', async () => {
    const { provider, requests } = fakeProvider([{ text: 'Check the Wi-Fi' }]);
    const result = await explainDeviceError({ provider, error: 'ETIMEDOUT', context: 'after reboot', device: { id: 1, apiKey: 'k' }, pluginName: 'ewelink' });
    expect(result.text).toBe('Check the Wi-Fi');
    const sent = userText(requests[0]);
    expect(sent).toContain('ETIMEDOUT');
    expect(sent).toContain('after reboot');
    expect(sent).toContain(REDACTED);
    expect(sent).not.toContain('"k"');
  });

  it('trims a huge device object', async () => {
    const { provider, requests } = fakeProvider([{ text: 'x' }], { contextTokens: 3000 });
    await explainDeviceError({ provider, error: 'E', device: { blob: 'z'.repeat(50_000) } });
    expect(userText(requests[0])).toContain('later characters trimmed');
  });

  it('works with the error alone', async () => {
    const { provider, requests } = fakeProvider([{ text: 'x' }]);
    await explainDeviceError({ provider, error: 'E' });
    expect(userText(requests[0])).not.toContain('## Device');
  });
});

describe('assessPluginUpdate', () => {
  it('returns the risk rating', async () => {
    const { provider, requests } = fakeProvider([{ text: '{"risk":"medium","summary":"Config moved.","breakingChanges":["rename x"]}' }]);
    const result = await assessPluginUpdate({ provider, pluginName: 'p', currentVersion: '1.0.0', targetVersion: '2.0.0', changelog: '## 2.0.0\n- BREAKING' });
    expect(result).toEqual({ risk: 'medium', summary: 'Config moved.', breakingChanges: ['rename x'], usage: { inputTokens: 10, outputTokens: 5 } });
    expect(userText(requests[0])).toContain('BREAKING');
  });
});

describe('suggestOrganization', () => {
  const reply = (data: unknown) => ({ text: JSON.stringify(data) });

  it('sends short aliases, maps them back and drops ids the model invented', async () => {
    const { provider, requests } = fakeProvider([
      reply({
        rooms: [{ name: 'Kitchen', accessories: ['a1', 'ghost'] }],
        renames: [{ uniqueId: 'a1', name: 'Kitchen Light' }, { uniqueId: 'ghost', name: 'x' }],
        orphans: [{ uniqueId: 'a2', reason: 'stale' }, { uniqueId: 'ghost', reason: 'x' }],
      }),
    ]);
    const long = 'f'.repeat(64);
    const result = await suggestOrganization({ provider, accessories: [{ uniqueId: long }, { uniqueId: 'b' }, 'junk'], rooms: [{ name: 'Default Room' }] });
    expect(userText(requests[0])).not.toContain(long);
    expect(userText(requests[0])).toContain('"uniqueId": "a1"');
    expect(result.rooms).toEqual([{ name: 'Kitchen', accessories: [long] }]);
    expect(result.renames).toEqual([{ uniqueId: long, name: 'Kitchen Light' }]);
    expect(result.orphans).toEqual([{ uniqueId: 'b', reason: 'stale' }]);
  });

  it('keeps everything when the input has no ids', async () => {
    const { provider } = fakeProvider([reply({ rooms: [{ name: 'R', accessories: ['x'] }], renames: [], orphans: [] })]);
    const result = await suggestOrganization({ provider, accessories: [{ name: 'no id' }] });
    expect(result.rooms[0].accessories).toEqual(['x']);
  });

  it('splits a large installation into requests that fit the output limit and merges them', async () => {
    const accessories = Array.from({ length: 12 }, (_, i) => ({ uniqueId: `id-${i}`, name: `Switch ${i}` }));
    const { provider, requests } = fakeProvider([
      reply({ rooms: [{ name: 'Kitchen', accessories: ['a1', 'a2'] }], renames: [{ uniqueId: 'a1', name: 'Kitchen Light' }], orphans: [] }),
      reply({ rooms: [{ name: 'Kitchen', accessories: ['a6'] }, { name: 'Hall', accessories: ['a7'] }], renames: [], orphans: [] }),
      reply({ rooms: [{ name: 'Hall', accessories: ['a11'] }], renames: [], orphans: [{ uniqueId: 'a12', reason: 'duplicate' }] }),
    ]);
    // 400 output tokens leave room for 5 accessories per request
    const result = await suggestOrganization({ provider, accessories, maxOutputTokens: 400 });
    expect(requests).toHaveLength(3);
    expect(userText(requests[0])).toContain('"a5"');
    expect(userText(requests[0])).not.toContain('"a6"');
    expect(userText(requests[2])).toContain('"a11"');
    expect(result.rooms).toEqual([
      { name: 'Kitchen', accessories: ['id-0', 'id-1', 'id-5'] },
      { name: 'Hall', accessories: ['id-6', 'id-10'] },
    ]);
    expect(result.renames).toEqual([{ uniqueId: 'id-0', name: 'Kitchen Light' }]);
    expect(result.orphans).toEqual([{ uniqueId: 'id-11', reason: 'duplicate' }]);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 15 });
  });

  it('still asks once when there are no accessories', async () => {
    const { provider, requests } = fakeProvider([reply({ rooms: [], renames: [], orphans: [] })]);
    const result = await suggestOrganization({ provider, accessories: [] });
    expect(requests).toHaveLength(1);
    expect(result.rooms).toEqual([]);
  });
});

describe('dailyDigest', () => {
  it('summarises what it is given', async () => {
    const { provider, requests } = fakeProvider([{ text: 'Digest' }]);
    const result = await dailyDigest({ provider, date: '2026-10-04', status: { up: true }, logs: ['warn a', 'error b'], updates: [{ name: 'p' }], accessories: [] });
    expect(result.text).toBe('Digest');
    const sent = userText(requests[0]);
    expect(sent).toContain('2026-10-04');
    expect(sent).toContain('error b');
  });

  it('defaults to today with minimal input', async () => {
    const { provider, requests } = fakeProvider([{ text: 'x' }, { text: 'y' }]);
    await dailyDigest({ provider });
    expect(userText(requests[0])).toContain(new Date().toISOString().slice(0, 10));
    await dailyDigest({ provider, logs: 'one line' });
    expect(userText(requests[1])).toContain('one line');
  });
});

describe('ask', () => {
  it('keeps history and redacts the prompt', async () => {
    const { provider, requests } = fakeProvider([{ text: 'Answer' }]);
    const result = await ask({ provider, prompt: 'my apiKey=abc why?', context: 'ctx', history: [{ role: 'user', content: 'before' }, { role: 'assistant', content: 'ok' }] });
    expect(result.text).toBe('Answer');
    expect(requests[0].messages).toHaveLength(3);
    expect(userText(requests[0], 2)).toContain(`apiKey=${REDACTED}`);
    expect(userText(requests[0], 2)).toContain('## Context\nctx');
  });

  it('works without context or history', async () => {
    const { provider, requests } = fakeProvider([{ text: 'x' }]);
    await ask({ provider, prompt: 'hi' });
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
