import { describe, expect, it, vi } from 'vitest';
import { isDestructive, runAgent, toToolDefinition } from '../../src/agent/run-agent.js';
import type { AgentEvent } from '../../src/agent/run-agent.js';
import { mockClient } from '../mcp/helpers.js';
import { fakeProvider } from '../../packages/ai-core/test/providers/helpers.js';

const lamp = { uniqueId: 'lamp', serviceName: 'Lamp', type: 'Lightbulb', values: { On: false } };

describe('runAgent', () => {
  it('runs tool calls against the real MCP tools and returns the final answer', async () => {
    const client = mockClient({ getAccessories: vi.fn().mockResolvedValue([lamp]) });
    const { provider, requests } = fakeProvider([
      { text: 'Let me look.', toolCalls: [{ id: 't1', name: 'list_accessories', arguments: {} }] },
      { text: 'The lamp is off.' },
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent({ provider, client, messages: [{ role: 'user', content: 'Is the lamp on?' }], onEvent: (e) => events.push(e) });

    expect(result.text).toBe('The lamp is off.');
    expect(result.steps).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: 'list_accessories', isError: false });
    expect(JSON.parse(result.toolCalls[0].result)[0].uniqueId).toBe('lamp');
    expect(result.messages).toHaveLength(4);

    // Tools are offered as JSON Schema, without $schema.
    const tools = requests[0].tools!;
    expect(tools.find((t) => t.name === 'list_accessories')?.inputSchema).toMatchObject({ type: 'object' });
    expect(tools.every((t) => !('$schema' in t.inputSchema))).toBe(true);
    // The tool result goes back as a user turn.
    expect(requests[1].messages[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', name: 'list_accessories' }] });
    expect(events.map((e) => e.type)).toEqual(['step', 'text', 'text', 'tool_call', 'tool_result', 'step', 'text', 'text']);
  });

  it('refuses destructive tools without confirmation and asks when a confirm callback exists', async () => {
    const client = mockClient({ restartServer: vi.fn().mockResolvedValue(undefined) });
    const { provider } = fakeProvider([{ toolCalls: [{ id: 'a', name: 'restart_homebridge', arguments: {} }] }, { text: 'ok' }]);
    const denied = await runAgent({ provider, client, messages: [{ role: 'user', content: 'restart' }] });
    expect(denied.toolCalls[0]).toMatchObject({ isError: true });
    expect(denied.toolCalls[0].result).toContain('did not allow restart_homebridge');
    expect(client.restartServer).not.toHaveBeenCalled();

    const confirm = vi.fn().mockResolvedValue(true);
    const { provider: p2 } = fakeProvider([{ toolCalls: [{ id: 'b', name: 'restart_homebridge', arguments: {} }] }, { text: 'done' }]);
    const allowed = await runAgent({ provider: p2, client, messages: [{ role: 'user', content: 'restart' }], confirm });
    expect(confirm).toHaveBeenCalledWith({ id: 'b', name: 'restart_homebridge', arguments: {} });
    expect(client.restartServer).toHaveBeenCalled();
    expect(allowed.toolCalls[0].isError).toBe(false);
  });

  it('does not ask before non-destructive writes', async () => {
    const client = mockClient({ getAccessory: vi.fn().mockResolvedValue(lamp), setAccessoryCharacteristic: vi.fn().mockResolvedValue({ ok: true }) });
    const confirm = vi.fn();
    const { provider } = fakeProvider([
      { toolCalls: [{ id: 'a', name: 'set_accessory', arguments: { uniqueId: 'lamp', characteristicType: 'On', value: true } }] },
      { text: 'on' },
    ]);
    await runAgent({ provider, client, messages: [{ role: 'user', content: 'on' }], confirm });
    expect(confirm).not.toHaveBeenCalled();
    expect(client.setAccessoryCharacteristic).toHaveBeenCalled();
  });

  it('hides write tools in read-only mode and reports unknown tools as errors', async () => {
    const { provider, requests } = fakeProvider([{ toolCalls: [{ id: 'x', name: 'update_config', arguments: {} }] }, { text: 'sorry' }]);
    const result = await runAgent({ provider, client: mockClient(), readOnly: true, messages: [{ role: 'user', content: 'x' }] });
    expect(requests[0].tools!.some((t) => t.name === 'update_config')).toBe(false);
    expect(result.toolCalls[0].isError).toBe(true);
  });

  it('reports a failing tool as an error result', async () => {
    const client = mockClient({ getConfig: vi.fn().mockRejectedValue(new Error('offline')) });
    const { provider } = fakeProvider([{ toolCalls: [{ id: 'x', name: 'get_config', arguments: {} }] }, { text: 'Homebridge is offline' }]);
    const result = await runAgent({ provider, client, messages: [{ role: 'user', content: 'x' }] });
    expect(result.toolCalls[0]).toMatchObject({ isError: true, result: 'Error getting config: offline' });
  });

  it('stops at maxSteps', async () => {
    const call = { toolCalls: [{ id: 'x', name: 'get_homebridge_status', arguments: {} }], text: 'checking' };
    const { provider } = fakeProvider([call, call]);
    const result = await runAgent({ provider, client: mockClient(), messages: [{ role: 'user', content: 'x' }], maxSteps: 2 });
    expect(result).toMatchObject({ steps: 2, truncated: true, text: 'checking' });
  });

  it('makes a single prompt-only call when the provider has no tools', async () => {
    const { provider, requests } = fakeProvider([{ text: 'just text' }], { tools: false });
    const result = await runAgent({ provider, client: mockClient(), system: 'S', messages: [{ role: 'user', content: 'x' }] });
    expect(result).toMatchObject({ text: 'just text', steps: 1, toolCalls: [], truncated: false });
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].system).toBe('S');
  });

  it('honours an aborted signal', async () => {
    const { provider } = fakeProvider([]);
    await expect(runAgent({ provider, client: mockClient(), messages: [], signal: AbortSignal.abort() })).rejects.toThrow();
  });
});

describe('helpers', () => {
  it('classifies destructive tools like MCP does', () => {
    const base = { name: 't', inputSchema: { type: 'object' as const } };
    expect(isDestructive({ ...base, annotations: { readOnlyHint: true } })).toBe(false);
    expect(isDestructive({ ...base, annotations: { readOnlyHint: false, destructiveHint: false } })).toBe(false);
    expect(isDestructive({ ...base, annotations: { readOnlyHint: false } })).toBe(true);
    expect(isDestructive(base)).toBe(true);
  });

  it('builds tool definitions with a fallback description', () => {
    expect(toToolDefinition({ name: 'a', title: 'A', inputSchema: { type: 'object' } })).toEqual({ name: 'a', description: 'A', inputSchema: { type: 'object' } });
    expect(toToolDefinition({ name: 'a', inputSchema: { type: 'object' } }).description).toBe('');
  });
});
