import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/create-server.js';
import type { HomebridgeClient } from '../../src/mcp/homebridge-client.js';
import { mockClient } from './helpers.js';

const STRUCTURED = [
  'list_accessories',
  'get_accessory',
  'list_plugins',
  'list_child_bridges',
  'get_child_bridge_health',
  'get_homebridge_status',
  'get_server_status',
  'search_logs',
  'list_scenes',
];

async function connect(client: HomebridgeClient) {
  const server = createServer(client, { live: false });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  await mcp.listTools(); // the client validates structuredContent against the cached schemas
  return mcp;
}

const client = () =>
  mockClient({
    getAccessories: vi.fn().mockResolvedValue([
      { uniqueId: 'a', serviceName: 'Lamp', type: 'Lightbulb', accessoryInformation: { Manufacturer: 'Hue', Model: 'LCT' }, values: { On: true } },
    ]),
    getAccessory: vi.fn().mockResolvedValue({ uniqueId: 'a', serviceName: 'Lamp', type: 'Lightbulb', serviceCharacteristics: [{ type: 'On', value: true }] }),
    getPlugins: vi.fn().mockResolvedValue([{ name: 'homebridge-hue', installedVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true, extra: 1 }]),
    getChildBridges: vi.fn().mockResolvedValue([{ username: '0E:3C:12:AB:CD:EF', name: 'Hue', plugin: 'homebridge-hue', status: 'ok', pin: 'secret' }]),
    getChildBridgeHealth: vi.fn().mockResolvedValue({
      crashLoop: { crashes: 3, windowMinutes: 10 },
      bridges: [{ username: '0E:3C:12:AB:CD:EF', name: 'Hue', status: 'ok', uptime: 60, upSince: null, restartCount: 0, crashCount: 0, crashLoop: false }],
    }),
    getHomebridgeStatus: vi.fn().mockResolvedValue({ status: 'up', port: 51826 }),
    getServerInformation: vi.fn().mockResolvedValue('not an object'),
    getLogTail: vi.fn().mockResolvedValue({ text: '[10/4/2026, 8:00:00 PM] [Hue] Error: lost\nplain line\n', truncated: false }),
    listScenes: vi.fn().mockResolvedValue([{ id: 'abc', name: 'Movie', actions: [], schedules: [] }]),
  });

describe('structured output', () => {
  it('advertises an outputSchema on the list/get tools', async () => {
    const { tools } = await (await connect(client())).listTools();
    const withSchema = tools.filter((t) => t.outputSchema).map((t) => t.name);
    expect(withSchema.sort()).toEqual([...STRUCTURED].sort());
  });

  it.each([
    ['list_accessories', {}, { accessories: [{ uniqueId: 'a', serviceName: 'Lamp', type: 'Lightbulb', manufacturer: 'Hue', model: 'LCT', values: { On: true } }] }],
    ['get_accessory', { uniqueId: 'a' }, { uniqueId: 'a', serviceName: 'Lamp', type: 'Lightbulb', serviceCharacteristics: [{ type: 'On', value: true }] }],
    ['list_child_bridges', {}, { childBridges: [{ username: '0E:3C:12:AB:CD:EF', name: 'Hue', plugin: 'homebridge-hue', status: 'ok' }] }],
    ['get_homebridge_status', {}, { status: 'up', port: 51826 }],
    ['get_server_status', {}, { value: 'not an object' }],
    ['list_scenes', {}, { scenes: [{ id: 'abc', name: 'Movie', actions: [], schedules: [] }] }],
  ])('%s returns valid structuredContent', async (name, args, expected) => {
    const result = await (await connect(client())).callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(result.structuredContent).toEqual(expected);
  });

  it('keeps the historical text for list tools', async () => {
    const result = await (await connect(client())).callTool({ name: 'list_plugins', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual([{ name: 'homebridge-hue', installedVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }]);
    expect(result.structuredContent).toEqual({ plugins: JSON.parse(text) });
  });

  it('returns child bridge health', async () => {
    const result = await (await connect(client())).callTool({ name: 'get_child_bridge_health', arguments: {} });
    expect((result.structuredContent as { bridges: unknown[] }).bridges).toHaveLength(1);
  });

  it('returns structured log matches', async () => {
    const result = await (await connect(client())).callTool({ name: 'search_logs', arguments: { pattern: 'l' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      total: 2,
      shown: 2,
      truncated: false,
      matches: [
        { line: 1, time: new Date(2026, 9, 4, 20).toISOString(), level: 'error', plugin: 'Hue', text: '[10/4/2026, 8:00:00 PM] [Hue] Error: lost' },
        { line: 2, time: new Date(2026, 9, 4, 20).toISOString(), level: 'error', plugin: 'Hue', text: 'plain line' },
      ],
    });
  });

  it('still reports errors without structured content', async () => {
    const c = client();
    (c.getPlugins as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
    const result = await (await connect(c)).callTool({ name: 'list_plugins', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});
