import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PROMPTS } from '@mp-consulting/homebridge-ai-core';

function message(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/** MCP prompts sharing their text with the built-in Assistant's templates. */
export function registerPrompts(server: McpServer): void {
  const p = PROMPTS.mcp;

  server.registerPrompt(
    'diagnose-logs',
    {
      title: p['diagnose-logs'].title,
      description: p['diagnose-logs'].description,
      argsSchema: { focus: z.string().optional().describe('A plugin, device or symptom to focus on') },
    },
    ({ focus }) => message(p['diagnose-logs'].text({ focus })),
  );

  server.registerPrompt(
    'plan-upgrade',
    {
      title: p['plan-upgrade'].title,
      description: p['plan-upgrade'].description,
      argsSchema: { plugin: z.string().optional().describe('One plugin to plan for (default: all with updates)') },
    },
    ({ plugin }) => message(p['plan-upgrade'].text({ plugin })),
  );

  server.registerPrompt(
    'audit-config',
    { title: p['audit-config'].title, description: p['audit-config'].description },
    () => message(p['audit-config'].text()),
  );
}
