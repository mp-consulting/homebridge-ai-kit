import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/create-server.js';
import type { HomebridgeClient } from '../../src/mcp/homebridge-client.js';
import { RESOURCE_TEMPLATES } from '../../src/mcp/resource-templates.js';
import { mockClient } from './helpers.js';

async function connect(client: HomebridgeClient) {
  const server = createServer(client, { live: false });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return mcp;
}

const bridge = { username: '0E:3C:12:AB:CD:EF', name: 'Hue Bridge', plugin: '@scope/homebridge-hue', status: 'ok', pin: '031-45-154', setupUri: 'X-HM://x' };

const client = (overrides: Parameters<typeof mockClient>[0] = {}) =>
  mockClient({
    getAccessories: vi.fn().mockResolvedValue([{ uniqueId: 'abc123', serviceName: 'Lamp', type: 'Lightbulb' }]),
    getAccessory: vi.fn().mockResolvedValue({ uniqueId: 'abc123', serviceName: 'Lamp', serviceCharacteristics: [] }),
    getPlugins: vi.fn().mockResolvedValue([{ name: '@scope/homebridge-hue', installedVersion: '1.0.0', description: 'Hue' }, { name: 'homebridge-ring' }]),
    getChildBridges: vi.fn().mockResolvedValue([bridge]),
    getChildBridgeHealth: vi.fn().mockResolvedValue({ crashLoop: { crashes: 3, windowMinutes: 10 }, bridges: [{ username: '0E:3C:12:AB:CD:EF', crashCount: 2 }] }),
    ...overrides,
  });

const read = async (mcp: Client, uri: string) => JSON.parse(((await mcp.readResource({ uri })).contents[0] as { text: string }).text);

describe('resource templates', () => {
  it('advertises the three templates', async () => {
    const { resourceTemplates } = await (await connect(client())).listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(Object.values(RESOURCE_TEMPLATES).sort());
  });

  it('lists one resource per accessory, plugin and child bridge', async () => {
    const { resources } = await (await connect(client())).listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain('homebridge://accessory/abc123');
    expect(uris).toContain('homebridge://plugin/%40scope%2Fhomebridge-hue');
    expect(uris).toContain('homebridge://plugin/homebridge-ring');
    expect(uris).toContain('homebridge://child-bridge/0E%3A3C%3A12%3AAB%3ACD%3AEF');
    expect(resources.find((r) => r.uri === 'homebridge://accessory/abc123')).toMatchObject({ name: 'Lamp', description: 'Lightbulb accessory' });
  });

  it('still lists when Homebridge fails or answers oddly', async () => {
    const mcp = await connect(
      client({ getAccessories: vi.fn().mockRejectedValue(new Error('down')), getPlugins: vi.fn().mockResolvedValue({}), getChildBridges: vi.fn().mockRejectedValue(new Error('403')) }),
    );
    const { resources } = await mcp.listResources();
    expect(resources.every((r) => !r.uri.includes('accessory/') && !r.uri.includes('plugin/') && !r.uri.includes('child-bridge/'))).toBe(true);
  });

  it('reads an accessory', async () => {
    const c = client();
    const mcp = await connect(c);
    expect(await read(mcp, 'homebridge://accessory/abc123')).toEqual({ uniqueId: 'abc123', serviceName: 'Lamp', serviceCharacteristics: [] });
    expect(c.getAccessory).toHaveBeenCalledWith('abc123');
  });

  it('reads a plugin by encoded or raw scoped name, with its child bridges', async () => {
    const mcp = await connect(client());
    const plugin = await read(mcp, 'homebridge://plugin/%40scope%2Fhomebridge-hue');
    expect(plugin.installedVersion).toBe('1.0.0');
    expect(plugin.childBridges).toHaveLength(1);
    expect((await read(mcp, 'homebridge://plugin/@scope/homebridge-hue')).name).toBe('@scope/homebridge-hue');
    await expect(mcp.readResource({ uri: 'homebridge://plugin/homebridge-nope' })).rejects.toThrow('Plugin homebridge-nope not found');
  });

  it('reads a child bridge without pairing codes, with health when available', async () => {
    const mcp = await connect(client());
    const b = await read(mcp, 'homebridge://child-bridge/0e3c12abcdef');
    expect(b).toEqual({ username: '0E:3C:12:AB:CD:EF', name: 'Hue Bridge', plugin: '@scope/homebridge-hue', status: 'ok', health: { username: '0E:3C:12:AB:CD:EF', crashCount: 2 } });

    const noHealth = await connect(client({ getChildBridgeHealth: vi.fn().mockRejectedValue(new Error('404')) }));
    expect((await read(noHealth, 'homebridge://child-bridge/0E:3C:12:AB:CD:EF')).health).toBeUndefined();
    await expect(noHealth.readResource({ uri: 'homebridge://child-bridge/FFFFFFFFFFFF' })).rejects.toThrow('Child bridge FFFFFFFFFFFF not found');
  });

  it('completes template variables', async () => {
    const mcp = await connect(client());
    const complete = (uri: string, name: string, value: string) =>
      mcp.complete({ ref: { type: 'ref/resource', uri }, argument: { name, value } }).then((r) => r.completion.values);
    expect(await complete(RESOURCE_TEMPLATES.accessory, 'uniqueId', 'ABC')).toEqual(['abc123']);
    expect(await complete(RESOURCE_TEMPLATES.plugin, 'name', 'ring')).toEqual(['homebridge-ring']);
    expect(await complete(RESOURCE_TEMPLATES.childBridge, 'id', '0e')).toEqual(['0E:3C:12:AB:CD:EF']);
  });
});
