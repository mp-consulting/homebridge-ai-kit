import { describe, it, expect, vi } from 'vitest';
import { register } from '../../../src/mcp/tools/server.js';
import { collectHandlers, collectTools, mockClient } from '../helpers.js';

function handlersFor(overrides: Parameters<typeof mockClient>[0] = {}) {
  const client = mockClient({
    getHomebridgeStatus: vi.fn().mockResolvedValue({ status: 'up' }),
    getServerInformation: vi.fn().mockResolvedValue({ version: '1.0.0' }),
    restartServer: vi.fn().mockResolvedValue(null),
    getPairingInfo: vi.fn().mockResolvedValue({ setupCode: '123-45-678' }),
    getCachedAccessories: vi.fn().mockResolvedValue([]),
    removeCachedAccessory: vi.fn().mockResolvedValue(undefined),
    resetCachedAccessories: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
  return { client, handlers: collectHandlers(register, client) };
}

describe('server tools', () => {
  describe('get_homebridge_status', () => {
    it('returns status', async () => {
      const { handlers } = handlersFor();
      const result = await handlers.get('get_homebridge_status')!({});
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 'up' });
    });

    it('handles errors', async () => {
      const { handlers } = handlersFor({ getHomebridgeStatus: vi.fn().mockRejectedValue(new Error('fail')) });
      const result = await handlers.get('get_homebridge_status')!({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error getting Homebridge status: fail');
    });
  });

  describe('get_server_status', () => {
    it('returns server information', async () => {
      const { handlers } = handlersFor();
      const result = await handlers.get('get_server_status')!({});
      expect(JSON.parse(result.content[0].text)).toEqual({ version: '1.0.0' });
    });
  });

  describe('restart_homebridge', () => {
    it('returns success message when result is falsy', async () => {
      const { handlers } = handlersFor();
      const result = await handlers.get('restart_homebridge')!({});
      expect(result.content[0].text).toContain('restart initiated successfully');
    });

    it('returns JSON when result is truthy', async () => {
      const { handlers } = handlersFor({ restartServer: vi.fn().mockResolvedValue({ status: 'restarting' }) });
      const result = await handlers.get('restart_homebridge')!({});
      expect(JSON.parse(result.content[0].text)).toEqual({ status: 'restarting' });
    });
  });

  describe('get_pairing_info', () => {
    it('returns pairing info', async () => {
      const { handlers } = handlersFor();
      const result = await handlers.get('get_pairing_info')!({});
      expect(JSON.parse(result.content[0].text)).toEqual({ setupCode: '123-45-678' });
    });
  });

  describe('get_cached_accessories', () => {
    const cached = {
      UUID: 'u1',
      displayName: 'Lamp',
      plugin: 'homebridge-hue',
      platform: 'Hue',
      category: 5,
      context: { big: 'blob' },
      services: [{ UUID: 's1', characteristics: [] }],
      $cacheFile: 'cachedAccessories.0E1234567890',
    };

    it('returns a compact summary including the cache file', async () => {
      const { handlers } = handlersFor({ getCachedAccessories: vi.fn().mockResolvedValue([cached]) });
      const result = await handlers.get('get_cached_accessories')!({});
      expect(JSON.parse(result.content[0].text)).toEqual([
        {
          UUID: 'u1',
          displayName: 'Lamp',
          plugin: 'homebridge-hue',
          platform: 'Hue',
          category: 5,
          cacheFile: 'cachedAccessories.0E1234567890',
        },
      ]);
    });

    it('returns full objects when verbose', async () => {
      const { handlers } = handlersFor({ getCachedAccessories: vi.fn().mockResolvedValue([cached]) });
      const result = await handlers.get('get_cached_accessories')!({ verbose: true });
      expect(JSON.parse(result.content[0].text)).toEqual([cached]);
    });
  });

  describe('remove_cached_accessory', () => {
    it('returns success message', async () => {
      const { client, handlers } = handlersFor();
      const result = await handlers.get('remove_cached_accessory')!({ uuid: 'u1' });
      expect(result.content[0].text).toBe('Cached accessory u1 removed successfully.');
      expect(client.removeCachedAccessory).toHaveBeenCalledWith('u1', undefined);
    });

    it('passes the cache file for child-bridge accessories', async () => {
      const { client, handlers } = handlersFor();
      await handlers.get('remove_cached_accessory')!({ uuid: 'u1', cacheFile: 'cachedAccessories.0E1234567890' });
      expect(client.removeCachedAccessory).toHaveBeenCalledWith('u1', 'cachedAccessories.0E1234567890');
    });

    it('handles errors', async () => {
      const { handlers } = handlersFor({ removeCachedAccessory: vi.fn().mockRejectedValue(new Error('fail')) });
      const result = await handlers.get('remove_cached_accessory')!({ uuid: 'u1' });
      expect(result.isError).toBe(true);
    });
  });

  describe('reset_cached_accessories', () => {
    it('returns success message', async () => {
      const { handlers } = handlersFor();
      const result = await handlers.get('reset_cached_accessories')!({});
      expect(result.content[0].text).toContain('reset');
    });
  });

  describe('annotations', () => {
    it('marks restart and cache removal as destructive and status reads as read-only', () => {
      const tools = collectTools(register, mockClient());
      for (const name of ['restart_homebridge', 'remove_cached_accessory', 'reset_cached_accessories']) {
        expect(tools.get(name)!.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      }
      for (const name of ['get_homebridge_status', 'get_server_status', 'get_pairing_info', 'get_cached_accessories']) {
        expect(tools.get(name)!.config.annotations.readOnlyHint).toBe(true);
      }
    });
  });
});
