import { describe, expect, it, vi } from 'vitest';
import { register } from '../../../src/mcp/tools/child-bridges.js';
import { HomebridgeApiError } from '../../../src/mcp/homebridge-client.js';
import { collectTools, mockClient } from '../helpers.js';

describe('child bridge tools', () => {
  it('lists child bridges with the useful fields', async () => {
    const client = mockClient({
      getChildBridges: vi.fn().mockResolvedValue([{ username: '0E:3C:12:AB:CD:EF', name: 'Hue', plugin: 'homebridge-hue', status: 'ok', pin: '031-45-154', setupUri: 'X-HM://' }]),
    });
    const result = await collectTools(register, client).get('list_child_bridges')!.handler();
    expect(JSON.parse(result.content[0].text)).toEqual([{ username: '0E:3C:12:AB:CD:EF', name: 'Hue', plugin: 'homebridge-hue', status: 'ok' }]);
  });

  it.each(['restart', 'stop', 'start'] as const)('%s_child_bridge calls the UI', async (action) => {
    const client = mockClient({ controlChildBridge: vi.fn().mockResolvedValue(undefined) });
    const tool = collectTools(register, client).get(`${action}_child_bridge`)!;
    expect(tool.config.annotations.destructiveHint).toBe(action !== 'start');
    const result = await tool.handler({ deviceId: '0E3C12ABCDEF' });
    expect(client.controlChildBridge).toHaveBeenCalledWith(action, '0E3C12ABCDEF');
    expect(result.content[0].text).toContain(`${action} requested`);
  });

  it('reports failures', async () => {
    const client = mockClient({ controlChildBridge: vi.fn().mockRejectedValue(new Error('403')) });
    const result = await collectTools(register, client).get('stop_child_bridge')!.handler({ deviceId: 'x' });
    expect(result.content[0].text).toBe('Error stopping child bridge: 403');
  });

  describe('get_child_bridge_health', () => {
    const report = {
      crashLoop: { crashes: 3, windowMinutes: 10 },
      bridges: [
        { username: '0E:3C:12:AB:CD:EF', name: 'Hue', plugin: 'homebridge-hue', status: 'ok', crashLoop: false },
        { username: '0E:3C:12:AB:CD:00', name: 'Ring', plugin: 'homebridge-ring', status: 'down', crashLoop: true },
      ],
    };

    it('returns the report, or one bridge', async () => {
      const client = mockClient({ getChildBridgeHealth: vi.fn().mockResolvedValue(report) });
      const tool = collectTools(register, client).get('get_child_bridge_health')!;
      expect(JSON.parse((await tool.handler()).content[0].text)).toEqual(report);
      const one = JSON.parse((await tool.handler({ deviceId: '0e3c12abcd00' })).content[0].text);
      expect(one.bridges.map((b: { name: string }) => b.name)).toEqual(['Ring']);
    });

    it('needs Glass UI', async () => {
      const path = '/api/status/homebridge/child-bridges/health';
      const client = mockClient({ getChildBridgeHealth: vi.fn().mockRejectedValue(new HomebridgeApiError(404, 'GET', path, `Cannot GET ${path}`)) });
      const result = await collectTools(register, client).get('get_child_bridge_health')!.handler();
      expect(result.content[0].text).toContain('Child bridge health requires Homebridge Glass UI');
    });
  });
});
