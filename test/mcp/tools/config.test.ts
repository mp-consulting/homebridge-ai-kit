import { describe, it, expect, vi } from 'vitest';
import { register } from '../../../src/mcp/tools/config.js';
import { REDACTED } from '@mp-consulting/homebridge-ai-core';
import { collectHandlers, mockClient } from '../helpers.js';

const realConfig = {
  bridge: { name: 'Homebridge', username: '0E:00:00:00:00:01', port: 51826, pin: '031-45-154' },
  platforms: [
    { platform: 'Hue', name: 'Hue', apiKey: 'hue-key' },
    { platform: 'Ring', name: 'Ring', refreshToken: 'ring-token' },
  ],
};

function handlersFor(overrides: Parameters<typeof mockClient>[0] = {}) {
  const client = mockClient({
    getConfig: vi.fn().mockResolvedValue(structuredClone(realConfig)),
    updateConfig: vi.fn().mockResolvedValue(null),
    ...overrides,
  });
  return { client, handlers: collectHandlers(register, client) };
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

    it('returns real values when includeSecrets is set', async () => {
      const { handlers } = handlersFor();
      const result = await handlers.get('get_config')!({ includeSecrets: true });
      expect(JSON.parse(result.content[0].text)).toEqual(realConfig);
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

    it('returns JSON when result is truthy', async () => {
      const { handlers } = handlersFor({ updateConfig: vi.fn().mockResolvedValue({ saved: true }) });
      const result = await handlers.get('update_config')!({ config: { bridge: {} } });
      expect(JSON.parse(result.content[0].text)).toEqual({ saved: true });
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
