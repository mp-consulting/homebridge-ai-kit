import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { redactSecrets } from '@mp-consulting/homebridge-ai-core';
import type { ToolRegistrar } from './tools/helpers.js';
import { errorMessage, errorResult } from './tools/helpers.js';

/** How much of the arguments the confirmation shows. */
const MAX_ARGS_CHARS = 600;

function describeArgs(args: Record<string, unknown>): string {
  if (Object.keys(args).length === 0) {
    return '';
  }
  // Arguments can carry a whole config.json; never show its secrets in the dialog.
  const text = JSON.stringify(redactSecrets(args as Parameters<typeof redactSecrets>[0]));
  return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS)}…` : text;
}

/**
 * Wraps a registrar so destructive tools (`destructiveHint: true`) ask the user to confirm through
 * MCP elicitation before they run, when the connected client supports form elicitation. Clients
 * without it, and dry runs (`dryRun: true`), run as before. A declined, cancelled or failed
 * confirmation returns an error result and the tool does not run.
 */
export function withElicitation(tool: ToolRegistrar, server: McpServer): ToolRegistrar {
  return (name, config, cb) => {
    if (config.annotations.destructiveHint !== true || config.annotations.readOnlyHint) {
      tool(name, config, cb);
      return;
    }
    const hasInput = config.inputSchema !== undefined;
    const run = cb as (...a: unknown[]) => CallToolResult | Promise<CallToolResult>;
    const confirmed = async (...a: unknown[]): Promise<CallToolResult> => {
      const args = (hasInput ? a[0] : {}) as Record<string, unknown>;
      if (args.dryRun === true || !server.server.getClientCapabilities()?.elicitation?.form) {
        return run(...a);
      }
      const shown = describeArgs(args);
      try {
        const answer = await server.server.elicitInput({
          message: `${config.title} (${name}) changes Homebridge and cannot simply be undone.${shown ? ` Arguments: ${shown}` : ''} Run it?`,
          requestedSchema: {
            type: 'object',
            properties: { confirm: { type: 'boolean', title: `Yes, ${config.title.toLowerCase()}`, default: false } },
            required: ['confirm'],
          },
        });
        if (answer.action !== 'accept' || answer.content?.confirm !== true) {
          return errorResult(`Not run: the user did not confirm ${name} (${answer.action === 'accept' ? 'unchecked' : answer.action}).`);
        }
      } catch (error) {
        return errorResult(`Not run: could not get the user's confirmation for ${name}: ${errorMessage(error)}`);
      }
      return run(...a);
    };
    tool(name, config, confirmed as typeof cb);
  };
}
