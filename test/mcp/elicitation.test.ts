import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../src/mcp/create-server.js';
import type { ServerOptions } from '../../src/mcp/create-server.js';
import type { HomebridgeClient } from '../../src/mcp/homebridge-client.js';
import { mockClient } from './helpers.js';

type Answer = ElicitResult | (() => never);

async function connect(client: HomebridgeClient, answer?: Answer, options: ServerOptions = {}) {
  const server = createServer(client, { live: false, ...options });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0' }, answer ? { capabilities: { elicitation: {} } } : {});
  const asked: Array<{ message: string }> = [];
  if (answer) {
    mcp.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params as { message: string });
      return typeof answer === 'function' ? answer() : answer;
    });
  }
  await Promise.all([server.connect(st), mcp.connect(ct)]);
  return { mcp, asked };
}

const hb = () =>
  mockClient({
    restartServer: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn().mockResolvedValue({ bridge: { name: 'HB' } }),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    listConfigBackups: vi.fn().mockResolvedValue([]),
    controlChildBridge: vi.fn().mockResolvedValue(undefined),
  });

const text = (r: object) => ((r as { content: Array<{ text: string }> }).content)[0].text;

describe('elicitation for destructive tools', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs the tool when the user confirms', async () => {
    const client = hb();
    const { mcp, asked } = await connect(client, { action: 'accept', content: { confirm: true } });
    const result = await mcp.callTool({ name: 'restart_homebridge', arguments: {} });
    expect(text(result)).toContain('restart initiated');
    expect(client.restartServer).toHaveBeenCalled();
    expect(asked[0].message).toContain('Restart Homebridge (restart_homebridge)');
  });

  it.each([
    [{ action: 'decline' } as ElicitResult, 'decline'],
    [{ action: 'cancel' } as ElicitResult, 'cancel'],
    [{ action: 'accept', content: { confirm: false } } as ElicitResult, 'unchecked'],
  ])('does not run when the answer is %j', async (answer, reason) => {
    const client = hb();
    const { mcp } = await connect(client, answer);
    const result = await mcp.callTool({ name: 'restart_homebridge', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Not run: the user did not confirm restart_homebridge (${reason}).`);
    expect(client.restartServer).not.toHaveBeenCalled();
  });

  it('fails closed when the confirmation errors', async () => {
    const client = hb();
    const { mcp } = await connect(client, () => {
      throw new Error('dialog crashed');
    });
    const result = await mcp.callTool({ name: 'restart_homebridge', arguments: {} });
    expect(text(result)).toContain("Not run: could not get the user's confirmation for restart_homebridge");
    expect(client.restartServer).not.toHaveBeenCalled();
  });

  it('shows redacted arguments and skips dry runs', async () => {
    const client = hb();
    const { mcp, asked } = await connect(client, { action: 'accept', content: { confirm: true } });
    const config = { bridge: { name: 'HB', pin: '031-45-154' }, platforms: [{ platform: 'X', password: 'hunter2' }] };
    await mcp.callTool({ name: 'update_config', arguments: { config } });
    expect(asked).toHaveLength(1);
    expect(asked[0].message).not.toContain('hunter2');
    expect(asked[0].message).not.toContain('031-45-154');
    expect(asked[0].message).toContain('"platform":"X"');

    await mcp.callTool({ name: 'update_config', arguments: { config, dryRun: true } });
    expect(asked).toHaveLength(1);
  });

  it('truncates long arguments', async () => {
    const { mcp, asked } = await connect(hb(), { action: 'accept', content: { confirm: true } });
    const config = { bridge: { name: 'x'.repeat(2000) } };
    await mcp.callTool({ name: 'update_config', arguments: { config } });
    expect(asked[0].message).toContain('…');
    expect(asked[0].message.length).toBeLessThan(800);
  });

  it('does not ask for non-destructive tools', async () => {
    const client = hb();
    const { mcp, asked } = await connect(client, { action: 'decline' });
    await mcp.callTool({ name: 'start_child_bridge', arguments: { deviceId: '0E3C12ABCDEF' } });
    expect(asked).toHaveLength(0);
    expect(client.controlChildBridge).toHaveBeenCalled();
  });

  it('runs as before for clients without elicitation', async () => {
    const client = hb();
    const { mcp } = await connect(client);
    await mcp.callTool({ name: 'restart_homebridge', arguments: {} });
    expect(client.restartServer).toHaveBeenCalled();
  });

  it('can be turned off with the option or HOMEBRIDGE_ELICITATION', async () => {
    const off = hb();
    const a = await connect(off, { action: 'decline' }, { elicitation: false });
    await a.mcp.callTool({ name: 'restart_homebridge', arguments: {} });
    expect(off.restartServer).toHaveBeenCalled();
    expect(a.asked).toHaveLength(0);

    vi.stubEnv('HOMEBRIDGE_ELICITATION', 'off');
    const env = hb();
    const b = await connect(env, { action: 'decline' });
    await b.mcp.callTool({ name: 'restart_homebridge', arguments: {} });
    expect(env.restartServer).toHaveBeenCalled();
  });
});
