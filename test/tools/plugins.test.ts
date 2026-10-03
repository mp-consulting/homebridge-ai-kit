import { describe, it, expect, vi } from 'vitest';
import { register } from '../../src/tools/plugins.js';
import { collectHandlers, mockClient } from '../helpers.js';

const installed = {
  name: 'homebridge-hue',
  displayName: 'Homebridge Hue',
  installedVersion: '1.0.0',
  latestVersion: '1.1.0',
  updateAvailable: true,
  verifiedPlugin: true,
  disabled: false,
  installPath: '/var/lib/homebridge/node_modules',
  keywords: ['homebridge-plugin', 'hue'],
  links: { npm: 'https://www.npmjs.com/package/homebridge-hue' },
};

function handlersFor(overrides: Parameters<typeof mockClient>[0] = {}) {
  const client = mockClient({
    getPlugins: vi.fn().mockResolvedValue([installed]),
    searchPlugins: vi.fn().mockResolvedValue([{ ...installed, description: 'Hue lights', lastUpdated: '2026-01-01' }]),
    lookupPlugin: vi.fn().mockResolvedValue({ name: 'homebridge-hue' }),
    getPluginVersions: vi.fn().mockResolvedValue({ tags: { latest: '1.0.0' } }),
    getPluginConfigSchema: vi.fn().mockResolvedValue({ schema: {} }),
    getPluginChangelog: vi.fn().mockResolvedValue('# Changelog\n## 1.0.0'),
    ...overrides,
  });
  return { client, handlers: collectHandlers(register, client) };
}

describe('plugins tools', () => {
  describe('list_plugins', () => {
    it('returns a compact plugin list', async () => {
      const { handlers } = handlersFor();
      const result = await handlers.get('list_plugins')!({});
      expect(JSON.parse(result.content[0].text)).toEqual([
        {
          name: 'homebridge-hue',
          displayName: 'Homebridge Hue',
          installedVersion: '1.0.0',
          latestVersion: '1.1.0',
          updateAvailable: true,
          verifiedPlugin: true,
          disabled: false,
        },
      ]);
    });

    it('returns every field when verbose', async () => {
      const { handlers } = handlersFor();
      const result = await handlers.get('list_plugins')!({ verbose: true });
      expect(JSON.parse(result.content[0].text)).toEqual([installed]);
    });

    it('handles errors', async () => {
      const { handlers } = handlersFor({ getPlugins: vi.fn().mockRejectedValue(new Error('fail')) });
      const result = await handlers.get('list_plugins')!({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error listing plugins: fail');
    });
  });

  describe('search_plugins', () => {
    it('searches and returns compact results', async () => {
      const { client, handlers } = handlersFor();
      const result = await handlers.get('search_plugins')!({ query: 'camera' });
      expect(client.searchPlugins).toHaveBeenCalledWith('camera');
      const [first] = JSON.parse(result.content[0].text);
      expect(first).toMatchObject({ name: 'homebridge-hue', description: 'Hue lights', lastUpdated: '2026-01-01' });
      expect(first).not.toHaveProperty('installPath');
      expect(first).not.toHaveProperty('keywords');
    });

    it('returns every field when verbose', async () => {
      const { handlers } = handlersFor();
      const result = await handlers.get('search_plugins')!({ query: 'camera', verbose: true });
      expect(JSON.parse(result.content[0].text)[0]).toHaveProperty('installPath');
    });
  });

  describe('lookup_plugin', () => {
    it('returns plugin details', async () => {
      const { handlers } = handlersFor();
      const result = await handlers.get('lookup_plugin')!({ pluginName: 'homebridge-hue' });
      expect(JSON.parse(result.content[0].text).name).toBe('homebridge-hue');
    });
  });

  describe('get_plugin_versions', () => {
    it('returns versions', async () => {
      const { handlers } = handlersFor();
      const result = await handlers.get('get_plugin_versions')!({ pluginName: 'homebridge-hue' });
      expect(JSON.parse(result.content[0].text).tags.latest).toBe('1.0.0');
    });
  });

  describe('get_plugin_config_schema', () => {
    it('returns config schema', async () => {
      const { handlers } = handlersFor();
      const result = await handlers.get('get_plugin_config_schema')!({ pluginName: 'homebridge-hue' });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({ schema: {} });
    });
  });

  describe('get_plugin_changelog', () => {
    it('returns string changelog as-is', async () => {
      const { handlers } = handlersFor();
      const result = await handlers.get('get_plugin_changelog')!({ pluginName: 'homebridge-hue' });
      expect(result.content[0].text).toBe('# Changelog\n## 1.0.0');
    });

    it('stringifies non-string changelog', async () => {
      const { handlers } = handlersFor({ getPluginChangelog: vi.fn().mockResolvedValue({ entries: [] }) });
      const result = await handlers.get('get_plugin_changelog')!({ pluginName: 'homebridge-hue' });
      expect(JSON.parse(result.content[0].text)).toEqual({ entries: [] });
    });

    it('handles errors', async () => {
      const { handlers } = handlersFor({ getPluginChangelog: vi.fn().mockRejectedValue(new Error('fail')) });
      const result = await handlers.get('get_plugin_changelog')!({ pluginName: 'x' });
      expect(result.isError).toBe(true);
    });
  });
});
