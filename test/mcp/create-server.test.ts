import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { VERSION, createServer, envFlag } from '../../src/mcp/create-server.js';
import type { ServerOptions } from '../../src/mcp/create-server.js';
import type { HomebridgeClient } from '../../src/mcp/homebridge-client.js';
import { mockClient } from './helpers.js';

const WRITE_TOOLS = [
  'set_accessory',
  'restart_homebridge',
  'remove_cached_accessory',
  'reset_cached_accessories',
  'update_config',
  'patch_config',
  'install_plugin',
  'update_plugin',
  'uninstall_plugin',
  'restart_child_bridge',
  'stop_child_bridge',
  'start_child_bridge',
  'restore_config',
  'create_backup',
  'set_accessories',
];

const TOOL_COUNT = 37;

/** Connect a real MCP client to the server over an in-memory transport. */
async function connect(client: HomebridgeClient = mockClient(), options: ServerOptions = {}) {
  const server = createServer(client, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

describe('createServer', () => {
  it('reports the package.json version', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const mcp = await connect();

    expect(VERSION).toBe(pkg.version);
    expect(mcp.getServerVersion()).toEqual({ name: 'homebridge-ai-kit', version: pkg.version });
  });

  it('registers all 37 tools with titles and annotations', async () => {
    const { tools } = await (await connect()).listTools();

    expect(tools).toHaveLength(TOOL_COUNT);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, tool.name).toBeTypeOf('boolean');
    }
    const writers = tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name);
    expect(writers.sort()).toEqual([...WRITE_TOOLS].sort());
  });

  it('omits every write tool in read-only mode', async () => {
    const { tools } = await (await connect(mockClient(), { readOnly: true })).listTools();
    const names = tools.map((t) => t.name);

    expect(tools).toHaveLength(TOOL_COUNT - WRITE_TOOLS.length);
    for (const name of WRITE_TOOLS) {
      expect(names).not.toContain(name);
    }
  });

  it('rejects an update_config without a bridge block before calling Homebridge', async () => {
    const client = mockClient({ updateConfig: vi.fn() });
    const mcp = await connect(client);
    const result = await mcp.callTool({ name: 'update_config', arguments: { config: {} } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('bridge');
    expect(client.updateConfig).not.toHaveBeenCalled();
  });

  it('passes extra config keys through untouched', async () => {
    const client = mockClient({ updateConfig: vi.fn().mockResolvedValue(null) });
    const mcp = await connect(client);
    const config = { bridge: { name: 'HB' }, platforms: [{ platform: 'X', custom: 1 }], disabledPlugins: ['a'] };
    await mcp.callTool({ name: 'update_config', arguments: { config } });

    expect(client.updateConfig).toHaveBeenCalledWith(config);
  });

  it('validates get_accessory_history input before calling Homebridge', async () => {
    const client = mockClient({ getAccessoryHistory: vi.fn() });
    const mcp = await connect(client);
    for (const args of [{ uniqueId: 'a', hours: 0 }, { uniqueId: 'a', hours: 9000 }, { uniqueId: 'a', maxPoints: 1 }, { uniqueId: 'a', type: '../x' }]) {
      const result = await mcp.callTool({ name: 'get_accessory_history', arguments: args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(client.getAccessoryHistory).not.toHaveBeenCalled();
  });

  it('runs a tool end to end', async () => {
    const client = mockClient({ getSystemInfo: vi.fn().mockResolvedValue({ os: 'linux' }) });
    const result = await (await connect(client)).callTool({ name: 'get_system_info', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: '{"os":"linux"}' }]);
  });
});

describe('envFlag', () => {
  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' true '])('treats %j as true', (value) => {
    expect(envFlag(value)).toBe(true);
  });

  it.each([undefined, '', '0', 'false', 'no', 'off', 'nope'])('treats %j as false', (value) => {
    expect(envFlag(value)).toBe(false);
  });
});
