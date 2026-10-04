import { randomBytes } from 'node:crypto';
import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { mcpClientSnippets, registerAiRoutes, testAiConnection } from '../dist/plugin/index.js';

/**
 * Custom settings UI server for the AI Kit platform. Exposes the shared
 * Assistant routes (/ai/status, /ai/ask, …) plus routes for the settings page.
 */
class AiKitUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    registerAiRoutes(this, { pluginName: '@mp-consulting/homebridge-ai-kit' });

    // Tests the provider settings currently in the form, saved or not.
    this.onRequest('/ai/test', (block) => testAiConnection(block));

    // A random bearer token for the HTTP MCP server.
    this.onRequest('/mcp/token', () => ({ token: randomBytes(24).toString('base64url') }));

    // Config snippets for Claude Desktop, Claude Code and Cursor.
    this.onRequest('/mcp/snippets', (body) => mcpClientSnippets(body));

    this.ready();
  }
}

(() => new AiKitUiServer())();
