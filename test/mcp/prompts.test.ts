import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PROMPTS } from '@mp-consulting/homebridge-ai-core';
import { registerPrompts } from '../../src/mcp/prompts.js';

async function connect() {
  const server = new McpServer({ name: 't', version: '0' });
  registerPrompts(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

const p = PROMPTS.mcp;

describe('registerPrompts', () => {
  it('lists the prompts with the shared titles and arguments', async () => {
    const { prompts } = await (await connect()).listPrompts();
    expect(prompts.map((x) => [x.name, x.title, x.arguments?.map((a) => a.name) ?? []])).toEqual([
      ['diagnose-logs', p['diagnose-logs'].title, ['focus']],
      ['plan-upgrade', p['plan-upgrade'].title, ['plugin']],
      ['audit-config', p['audit-config'].title, []],
    ]);
    expect(prompts.every((x) => x.description)).toBe(true);
  });

  it('renders each prompt as one user message from the shared templates', async () => {
    const mcp = await connect();
    const text = async (name: string, args?: Record<string, string>) => {
      const { messages } = await mcp.getPrompt({ name, arguments: args });
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
      return (messages[0].content as { text: string }).text;
    };
    expect(await text('diagnose-logs', { focus: 'homebridge-hue' })).toBe(p['diagnose-logs'].text({ focus: 'homebridge-hue' }));
    expect(await text('diagnose-logs')).toBe(p['diagnose-logs'].text({}));
    expect(await text('plan-upgrade', { plugin: 'homebridge-ring' })).toBe(p['plan-upgrade'].text({ plugin: 'homebridge-ring' }));
    expect(await text('audit-config')).toBe(p['audit-config'].text());
  });
});
