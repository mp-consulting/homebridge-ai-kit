import { describe, expect, it, vi } from 'vitest';
import { mergePatch, register } from '../../../src/mcp/tools/config.js';
import { REDACTED } from '@mp-consulting/homebridge-ai-core';
import { collectHandlers, mockClient } from '../helpers.js';

const config = () => ({
  bridge: { name: 'HB' },
  platforms: [
    { platform: 'Hue', name: 'Upstairs', apiKey: 'k1', options: { a: 1, b: 2 } },
    { platform: 'Hue', name: 'Downstairs', apiKey: 'k2' },
    { platform: 'Ring', name: 'Ring', token: 't' },
  ],
  accessories: [{ accessory: 'Fan', name: 'Fan', speed: 1 }],
});

function setup(cfg: Record<string, unknown> = config()) {
  const client = mockClient({ getConfig: vi.fn().mockResolvedValue(cfg), updateConfig: vi.fn().mockResolvedValue(undefined) });
  return { client, patch: collectHandlers(register, client).get('patch_config')! };
}

describe('mergePatch', () => {
  it('merges objects, replaces arrays and deletes null keys', () => {
    expect(mergePatch({ a: { x: 1, y: 2 }, list: [1], gone: true }, { a: { y: 3 }, list: [2], gone: null, add: 'n' })).toEqual({
      a: { x: 1, y: 3 },
      list: [2],
      add: 'n',
    });
  });
});

describe('patch_config', () => {
  it('patches one platform block by platform and name, keeping secrets', async () => {
    const { client, patch } = setup();
    const result = await patch({ platform: 'Hue', name: 'Upstairs', patch: { apiKey: REDACTED, options: { b: 3 }, platform: 'Evil' } });
    const written = (client.updateConfig as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(written.platforms[0]).toEqual({ platform: 'Hue', name: 'Upstairs', apiKey: 'k1', options: { a: 1, b: 3 } });
    expect(written.platforms[1]).toEqual(config().platforms[1]);
    expect(written.bridge).toEqual({ name: 'HB' });
    expect(JSON.parse(result.content[0].text).updated.apiKey).toBe(REDACTED);
  });

  it('patches an accessory block', async () => {
    const { client, patch } = setup();
    await patch({ accessory: 'Fan', patch: { speed: 2 } });
    expect((client.updateConfig as ReturnType<typeof vi.fn>).mock.calls[0][0].accessories[0].speed).toBe(2);
  });

  it('refuses ambiguous, missing or malformed targets', async () => {
    const { client, patch } = setup();
    expect((await patch({ platform: 'Hue', patch: {} })).content[0].text).toContain('Several platform blocks');
    expect((await patch({ platform: 'Nope', patch: {} })).content[0].text).toBe('No platform block "Nope" in config.json.');
    expect((await patch({ platform: 'Hue', name: 'Attic', patch: {} })).content[0].text).toContain('named "Attic"');
    expect((await patch({ patch: {} })).content[0].text).toContain('exactly one of');
    expect((await patch({ platform: 'a', accessory: 'b', patch: {} })).isError).toBe(true);
    expect(client.updateConfig).not.toHaveBeenCalled();
  });

  it('handles a config without the list', async () => {
    const { patch } = setup({ bridge: {} });
    expect((await patch({ accessory: 'Fan', patch: {} })).content[0].text).toContain('No accessory block');
  });

  it('fails when a placeholder has no secret to restore', async () => {
    const { client, patch } = setup();
    const result = await patch({ platform: 'Ring', patch: { password: REDACTED } });
    expect(result.isError).toBe(true);
    expect(client.updateConfig).not.toHaveBeenCalled();
  });
});
