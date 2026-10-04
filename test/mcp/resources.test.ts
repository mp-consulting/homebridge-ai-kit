import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../src/mcp/create-server.js';
import type { ServerOptions } from '../../src/mcp/create-server.js';
import type { HomebridgeClient } from '../../src/mcp/homebridge-client.js';
import type { LiveSource } from '../../src/mcp/live.js';
import { RESOURCE_URIS } from '../../src/mcp/resources.js';
import { mockClient } from './helpers.js';

async function connect(client: HomebridgeClient, options: ServerOptions = {}) {
  const server = createServer(client, options);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return { mcp, server };
}

const client = () =>
  mockClient({
    getAccessories: vi.fn().mockResolvedValue([{ uniqueId: 'a', serviceName: 'Lamp', type: 'Lightbulb', values: { On: true } }, { uniqueId: 'b', serviceName: 'S', type: 'Switch' }]),
    getLogTail: vi.fn().mockResolvedValue({ text: Array.from({ length: 300 }, (_, i) => `\u001B[32mline ${i}\u001B[0m`).join('\n'), truncated: false }),
    getHomebridgeStatus: vi.fn().mockResolvedValue({ status: 'up' }),
    getChildBridges: vi.fn().mockRejectedValue(new Error('403')),
  });

describe('resources', () => {
  it('lists and reads the three resources', async () => {
    const { mcp } = await connect(client(), { live: false });
    const { resources } = await mcp.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(Object.values(RESOURCE_URIS).sort());

    const acc = await mcp.readResource({ uri: RESOURCE_URIS.accessories });
    expect(JSON.parse((acc.contents[0] as { text: string }).text)).toEqual([
      { uniqueId: 'a', serviceName: 'Lamp', type: 'Lightbulb', values: { On: true } },
      { uniqueId: 'b', serviceName: 'S', type: 'Switch', values: {} },
    ]);
    const logs = ((await mcp.readResource({ uri: RESOURCE_URIS.logs })).contents[0] as { text: string }).text;
    expect(logs.split('\n')).toHaveLength(200);
    expect(logs.endsWith('line 299')).toBe(true);
    expect(logs).not.toContain('\u001B');
    const status = await mcp.readResource({ uri: RESOURCE_URIS.status });
    expect(JSON.parse((status.contents[0] as { text: string }).text)).toEqual({ status: { status: 'up' } });
  });

  it('does not offer subscriptions without a live source', async () => {
    const { mcp } = await connect(client(), { live: false });
    expect(mcp.getServerCapabilities()?.resources?.subscribe).toBeUndefined();
  });

  it('subscribes, notifies and unsubscribes', async () => {
    const watches: Array<{ topic: string; fire: () => void; close: ReturnType<typeof vi.fn> }> = [];
    const live: LiveSource = (topic, onChange) => {
      const w = { topic, fire: onChange, close: vi.fn() };
      watches.push(w);
      return w;
    };
    const { mcp, server } = await connect(client(), { live });
    expect(mcp.getServerCapabilities()?.resources?.subscribe).toBe(true);

    const updates: string[] = [];
    mcp.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri);
    });
    await mcp.subscribeResource({ uri: RESOURCE_URIS.logs });
    await mcp.subscribeResource({ uri: RESOURCE_URIS.logs });
    await mcp.subscribeResource({ uri: RESOURCE_URIS.status });
    expect(watches.map((w) => w.topic)).toEqual(['log', 'status']);

    watches[0].fire();
    await vi.waitFor(() => expect(updates).toEqual([RESOURCE_URIS.logs]));

    await mcp.unsubscribeResource({ uri: RESOURCE_URIS.logs });
    expect(watches[0].close).toHaveBeenCalled();
    await mcp.unsubscribeResource({ uri: 'homebridge://unknown' });

    await expect(mcp.subscribeResource({ uri: 'homebridge://nope' })).rejects.toThrow('Cannot subscribe');

    await server.close();
    expect(watches[1].close).toHaveBeenCalled();
  });
});

describe('prompts', () => {
  it('lists and renders the MCP prompts', async () => {
    const { mcp } = await connect(mockClient(), { live: false });
    const { prompts } = await mcp.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['diagnose-logs', 'plan-upgrade', 'audit-config']);

    const diag = await mcp.getPrompt({ name: 'diagnose-logs', arguments: { focus: 'Ring' } });
    expect(diag.messages[0]).toMatchObject({ role: 'user', content: { type: 'text' } });
    expect((diag.messages[0].content as { text: string }).text).toContain('Focus on: Ring');
    const plan = await mcp.getPrompt({ name: 'plan-upgrade', arguments: {} });
    expect((plan.messages[0].content as { text: string }).text).toContain('list_plugins');
    const audit = await mcp.getPrompt({ name: 'audit-config' });
    expect((audit.messages[0].content as { text: string }).text).toContain('get_config');
  });
});
