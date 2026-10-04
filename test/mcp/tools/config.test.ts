import { describe, it, expect, vi } from 'vitest';
import { register } from '../../../src/mcp/tools/config.js';
import { REDACTED } from '@mp-consulting/homebridge-ai-core';
import { collectHandlers, collectTools, mockClient } from '../helpers.js';

const realConfig = {
  bridge: { name: 'Homebridge', username: '0E:00:00:00:00:01', port: 51826, pin: '031-45-154' },
  platforms: [
    { platform: 'Hue', name: 'Hue', apiKey: 'hue-key' },
    { platform: 'Ring', name: 'Ring', refreshToken: 'ring-token' },
  ],
};

function handlersFor(overrides: Parameters<typeof mockClient>[0] = {}, allowSecrets = false) {
  const client = mockClient({
    getConfig: vi.fn().mockResolvedValue(structuredClone(realConfig)),
    updateConfig: vi.fn().mockResolvedValue(null),
    ...overrides,
  });
  return { client, handlers: collectHandlers(register, client, { allowSecrets }) };
}

describe('config tools', () => {
  describe('get_config', () => {
    it('redacts secrets by default', async () => {
      const { handlers } = handlersFor();
      const result = await handlers.get('get_config')!({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.bridge).toEqual({ ...realConfig.bridge, pin: REDACTED });
      expect(parsed.platforms[0].apiKey).toBe(REDACTED);
      expect(parsed.platforms[1].refreshToken).toBe(REDACTED);
      expect(result.content[0].text).not.toContain('hue-key');
    });

    it('returns real values when includeSecrets is set and the server allows it', async () => {
      const { handlers } = handlersFor({}, true);
      const result = await handlers.get('get_config')!({ includeSecrets: true });
      expect(JSON.parse(result.content[0].text)).toEqual(realConfig);
    });

    it('keeps secrets redacted unless the server allows them', async () => {
      const client = mockClient({ getConfig: vi.fn().mockResolvedValue(structuredClone(realConfig)) });
      const tools = collectTools(register, client);
      const getConfig = tools.get('get_config')!;
      expect(getConfig.config.inputSchema).toEqual({});
      expect(getConfig.config.description).toContain('never returns the real secret values');
      const result = await getConfig.handler({ includeSecrets: true });
      expect(result.content[0].text).not.toContain('hue-key');
      expect(collectTools(register, client, { allowSecrets: true }).get('get_config')!.config.inputSchema).toHaveProperty('includeSecrets');
    });

    it('handles errors', async () => {
      const { handlers } = handlersFor({ getConfig: vi.fn().mockRejectedValue(new Error('fail')) });
      const result = await handlers.get('get_config')!({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error getting config: fail');
    });
  });

  describe('update_config', () => {
    it('returns success message when result is falsy', async () => {
      const { client, handlers } = handlersFor();
      const result = await handlers.get('update_config')!({ config: { bridge: {} } });
      expect(result.content[0].text).toContain('Config updated successfully');
      expect(client.updateConfig).toHaveBeenCalledWith({ bridge: {} });
    });

    it('does not re-read the config when there is nothing to restore', async () => {
      const { client, handlers } = handlersFor();
      await handlers.get('update_config')!({ config: { bridge: {} } });
      expect(client.getConfig).not.toHaveBeenCalled();
    });

    it('does not echo the saved file (with its secrets) back', async () => {
      const { handlers } = handlersFor({ updateConfig: vi.fn().mockResolvedValue(realConfig) });
      const result = await handlers.get('update_config')!({ config: { bridge: {} } });
      expect(result.content[0].text).toContain('Config updated successfully');
      expect(result.content[0].text).not.toContain('hue-key');
    });

    it('names the backup the UI made of the previous file', async () => {
      const { handlers } = handlersFor({
        listConfigBackups: vi.fn().mockResolvedValue([
          { id: '1700000000000', timestamp: '2023-11-14T22:13:20.000Z' },
          { id: '1800000000000', timestamp: '2027-01-15T08:00:00.000Z' },
        ]),
      });
      const result = await handlers.get('update_config')!({ config: { bridge: {} } });
      expect(result.content[0].text).toContain('backupId "1800000000000"');
    });

    it('previews a redacted diff on dryRun without writing', async () => {
      const { client, handlers } = handlersFor();
      const config = structuredClone(realConfig);
      config.bridge.name = 'Home';
      config.platforms[0].apiKey = 'new-secret';
      const result = await handlers.get('update_config')!({ config, dryRun: true });
      const preview = JSON.parse(result.content[0].text);

      expect(client.updateConfig).not.toHaveBeenCalled();
      expect(preview.dryRun).toBe(true);
      expect(preview.changes).toEqual([{ path: 'bridge.name', op: 'change', before: 'Homebridge', after: 'Home' }]);
      expect(preview.diff).toContain('-    "name": "Homebridge",');
      expect(preview.diff).toContain('+    "name": "Home",');
      expect(result.content[0].text).not.toContain('new-secret');
      expect(result.content[0].text).not.toContain('hue-key');
    });

    it('restores placeholders before previewing a dryRun', async () => {
      const { handlers } = handlersFor();
      const read = JSON.parse((await handlers.get('get_config')!({})).content[0].text);
      const preview = JSON.parse((await handlers.get('update_config')!({ config: read, dryRun: true })).content[0].text);
      expect(preview.changed).toBe(0);
      expect(preview.note).toContain('No changes');
    });

    it('round-trips a redacted config back to the real secrets', async () => {
      const { client, handlers } = handlersFor();
      const read = JSON.parse((await handlers.get('get_config')!({})).content[0].text);

      // The model renames the bridge and reorders the platforms.
      read.bridge.name = 'Home';
      read.platforms.reverse();
      await handlers.get('update_config')!({ config: read });

      expect(client.updateConfig).toHaveBeenCalledWith({
        bridge: { ...realConfig.bridge, name: 'Home' },
        platforms: [realConfig.platforms[1], realConfig.platforms[0]],
      });
    });

    it('refuses to write a placeholder it cannot restore', async () => {
      const { client, handlers } = handlersFor();
      const result = await handlers.get('update_config')!({
        config: { bridge: {}, platforms: [{ platform: 'Nest', name: 'Nest', token: REDACTED }] },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('platforms[0].token');
      expect(client.updateConfig).not.toHaveBeenCalled();
    });

    it('handles errors', async () => {
      const { handlers } = handlersFor({ updateConfig: vi.fn().mockRejectedValue(new Error('fail')) });
      const result = await handlers.get('update_config')!({ config: { bridge: {} } });
      expect(result.isError).toBe(true);
    });
  });
});
