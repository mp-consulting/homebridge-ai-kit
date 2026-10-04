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
  'set_security_accessory',
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
];

const TOOL_COUNT = 33;

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

  it('registers all 33 tools with titles and annotations', async () => {
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

  it('only returns secrets when allowed, and never in read-only mode', async () => {
    const client = mockClient({ getConfig: vi.fn().mockResolvedValue({ bridge: { pin: '031-45-154' } }) });
    const call = async (options: ServerOptions) => {
      const mcp = await connect(client, options);
      const schema = (await mcp.listTools()).tools.find((t) => t.name === 'get_config')!.inputSchema;
      const result = await mcp.callTool({ name: 'get_config', arguments: { includeSecrets: true } });
      return { hasParam: 'includeSecrets' in (schema.properties ?? {}), text: JSON.stringify(result.content) };
    };
    expect(await call({})).toMatchObject({ hasParam: false, text: expect.not.stringContaining('031-45-154') });
    expect(await call({ readOnly: true, allowSecrets: true })).toMatchObject({ hasParam: false, text: expect.not.stringContaining('031-45-154') });
    expect(await call({ allowSecrets: true })).toMatchObject({ hasParam: true, text: expect.stringContaining('031-45-154') });
  });

  it('registers only the tools a scope allows', async () => {
    const names = async (options: ServerOptions) => (await (await connect(mockClient(), options)).listTools()).tools.map((t) => t.name);
    const control = await names({ scope: 'control' });
    expect(control.filter((n) => WRITE_TOOLS.includes(n)).sort()).toEqual(['set_accessory', 'set_security_accessory']);
    expect(control).toHaveLength(TOOL_COUNT - WRITE_TOOLS.length + 2);
    expect(await names({ scope: 'read' })).toHaveLength(TOOL_COUNT - WRITE_TOOLS.length);
    expect(await names({ scope: 'admin', readOnly: true })).toHaveLength(TOOL_COUNT - WRITE_TOOLS.length);
    expect(await names({ scope: 'admin' })).toHaveLength(TOOL_COUNT);
    // Secrets are admin-only.
    const schema = async (options: ServerOptions) =>
      (await (await connect(mockClient(), options)).listTools()).tools.find((t) => t.name === 'get_config')!.inputSchema.properties ?? {};
    expect(await schema({ scope: 'control', allowSecrets: true })).not.toHaveProperty('includeSecrets');
  });

  it('audits write tool calls with redacted arguments, but not reads', async () => {
    const records: unknown[] = [];
    const audit = { record: vi.fn((e: unknown) => void records.push(e)) };
    const client = mockClient({
      getAccessory: vi.fn().mockResolvedValue({ uniqueId: 'lamp', serviceName: 'Lamp', type: 'Lightbulb' }),
      setAccessoryCharacteristic: vi.fn().mockResolvedValue({ ok: true }),
      getConfig: vi.fn().mockResolvedValue({ bridge: {}, platforms: [{ platform: 'X', password: 'hunter2' }] }),
      updateConfig: vi.fn().mockRejectedValue(new Error('disk full, token=abc123')),
      restartServer: vi.fn().mockResolvedValue(undefined),
    });
    const mcp = await connect(client, { audit, principal: 'default' });
    await mcp.callTool({ name: 'get_config', arguments: {} });
    await mcp.callTool({ name: 'set_accessory', arguments: { uniqueId: 'lamp', characteristicType: 'On', value: true } });
    await mcp.callTool({ name: 'update_config', arguments: { config: { bridge: {}, platforms: [{ platform: 'X', password: 'hunter2' }] } } });
    await mcp.callTool({ name: 'restart_homebridge', arguments: {} });

    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      tool: 'set_accessory',
      args: { uniqueId: 'lamp', characteristicType: 'On', value: true },
      ok: true,
      client: 'test/0.0.0',
      principal: 'default',
      scope: 'admin',
      ts: expect.stringMatching(/^\d{4}-/),
    });
    expect(records[1]).toMatchObject({ tool: 'update_config', ok: false, error: expect.stringContaining('disk full') });
    expect(JSON.stringify(records[1])).not.toContain('hunter2');
    expect(JSON.stringify(records[1])).not.toContain('abc123');
    expect(records[2]).toMatchObject({ tool: 'restart_homebridge', args: {}, ok: true });
  });

  it('keeps a write working when the audit sink fails', async () => {
    const audit = { record: vi.fn().mockRejectedValue(new Error('sink down')) };
    const client = mockClient({ restartServer: vi.fn().mockResolvedValue(undefined) });
    const result = await (await connect(client, { audit })).callTool({ name: 'restart_homebridge', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ tool: 'restart_homebridge', ok: true }));
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
