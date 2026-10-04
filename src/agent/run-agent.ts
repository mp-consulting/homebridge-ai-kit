/**
 * The agent loop: an LLM provider on one side, the Homebridge MCP tools on
 * the other, connected in-process through the MCP SDK's in-memory transport.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createServer, VERSION } from '../mcp/create-server.js';
import type { HomebridgeClient } from '../mcp/homebridge-client.js';
import type { AuditSink } from '../mcp/audit.js';
import { untrusted } from '../mcp/tools/helpers.js';
import { PROMPTS, addUsage, complete, redactSecrets } from '@mp-consulting/homebridge-ai-core';
import type { AiProvider, ChatMessage, ChatResult, ContentPart, TokenUsage, ToolCall, ToolDefinition } from '@mp-consulting/homebridge-ai-core';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; call: ToolCall; result: string; isError: boolean }
  | { type: 'step'; step: number };

export interface RunAgentOptions {
  provider: AiProvider;
  client: HomebridgeClient;
  /** Expose only read-only tools. */
  readOnly?: boolean;
  system?: string;
  messages: ChatMessage[];
  /** Maximum model calls (default 8). */
  maxSteps?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Progress: streamed text, tool calls and their results. Streaming is used when given. */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Asked before each destructive tool call (restart, config write, uninstall…).
   * Without it, destructive calls are refused.
   */
  confirm?: (call: ToolCall) => Promise<boolean>;
  /** Records every write tool call the agent makes (principal `agent`), e.g. `createAuditLog()`. */
  audit?: AuditSink;
}

export interface AgentToolCall extends ToolCall {
  result: string;
  isError: boolean;
}

export interface AgentResult {
  text: string;
  /** Model calls made. */
  steps: number;
  toolCalls: AgentToolCall[];
  usage: TokenUsage;
  /** The conversation including the agent's turns, to continue it later. */
  messages: ChatMessage[];
  /** True when the loop stopped at `maxSteps` with tool calls still pending. */
  truncated: boolean;
}

/** MCP marks a tool destructive unless it says otherwise; read-only tools never are. */
export function isDestructive(tool: Tool): boolean {
  const a = tool.annotations;
  if (a?.readOnlyHint === true) {
    return false;
  }
  return a?.destructiveHint !== false;
}

export function toToolDefinition(tool: Tool): ToolDefinition {
  const inputSchema: Record<string, unknown> = { ...tool.inputSchema };
  delete inputSchema.$schema;
  return { name: tool.name, description: tool.description ?? tool.title ?? '', inputSchema };
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
}

/** A destructive call the user did not allow never reaches the server, so it is audited here. */
async function recordRefusal(audit: AuditSink | undefined, call: ToolCall): Promise<void> {
  try {
    await audit?.record({
      ts: new Date().toISOString(),
      tool: call.name,
      args: redactSecrets(call.arguments),
      ok: false,
      error: 'not allowed by the user',
      notConfirmed: true,
      principal: 'agent',
    });
  } catch {
    // Auditing must not break the conversation.
  }
}

export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const { provider, client, onEvent, signal } = options;
  const maxSteps = options.maxSteps ?? 8;
  const system = options.system ?? PROMPTS.ask.system;
  const messages = [...options.messages];
  const onText = onEvent ? (delta: string) => onEvent({ type: 'text', delta }) : undefined;

  if (!provider.capabilities.tools) {
    const result = await complete(provider, { system, messages, maxOutputTokens: options.maxOutputTokens, signal }, onText);
    messages.push(result.message);
    return { text: result.text, steps: 1, toolCalls: [], usage: result.usage, messages, truncated: false };
  }

  const server = createServer(client, { readOnly: options.readOnly, live: false, audit: options.audit, principal: 'agent' });
  const mcp = new Client({ name: 'homebridge-ai-kit-agent', version: VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    const { tools } = await mcp.listTools();
    const destructive = new Set(tools.filter(isDestructive).map((t) => t.name));
    const definitions = tools.map(toToolDefinition);

    const toolCalls: AgentToolCall[] = [];
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let last: ChatResult | undefined;
    let steps = 0;

    while (steps < maxSteps) {
      signal?.throwIfAborted();
      steps++;
      onEvent?.({ type: 'step', step: steps });
      last = await complete(provider, { system, messages, tools: definitions, maxOutputTokens: options.maxOutputTokens, signal }, onText);
      usage = addUsage(usage, last.usage);
      messages.push(last.message);
      if (last.toolCalls.length === 0) {
        return { text: last.text, steps, toolCalls, usage, messages, truncated: false };
      }

      const results: ContentPart[] = [];
      for (const call of last.toolCalls) {
        onEvent?.({ type: 'tool_call', call });
        let result: string;
        let isError: boolean;
        // What the model sees: tool output carries Homebridge text (names, logs), so it goes back as untrusted data.
        let content: string | undefined;
        if (destructive.has(call.name) && !(await options.confirm?.(call))) {
          result = `The user did not allow ${call.name}. Do not retry it; explain what it would have done instead.`;
          isError = true;
          await recordRefusal(options.audit, call);
        } else {
          try {
            const out = await mcp.callTool({ name: call.name, arguments: call.arguments });
            result = resultText(out);
            isError = out.isError === true;
            content = untrusted(call.name, result);
          } catch (error) {
            result = error instanceof Error ? error.message : String(error);
            isError = true;
            content = untrusted(call.name, result);
          }
        }
        onEvent?.({ type: 'tool_result', call, result, isError });
        toolCalls.push({ ...call, result, isError });
        results.push({ type: 'tool_result', toolCallId: call.id, name: call.name, content: content ?? result, isError });
      }
      messages.push({ role: 'user', content: results });
    }
    return { text: last?.text ?? '', steps, toolCalls, usage, messages, truncated: true };
  } finally {
    await mcp.close();
    await server.close();
  }
}
