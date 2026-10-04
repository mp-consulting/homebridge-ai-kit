/** Config snippets that point outside MCP clients at this Homebridge. */

export interface SnippetOptions {
  /** Homebridge UI URL, e.g. http://192.168.1.10:8581. */
  homebridgeUrl: string;
  /** The HTTP MCP server, when enabled in the plugin. */
  http?: { host: string; port: number; token?: string };
  /** Put the real token in the snippet instead of a placeholder. */
  includeToken?: boolean;
}

export interface McpClientSnippets {
  /** `claude_desktop_config.json` → mcpServers entry. */
  claudeDesktop: string;
  /** A `claude mcp add` command line. */
  claudeCode: string;
  /** `.cursor/mcp.json` → mcpServers entry. */
  cursor: string;
}

const TOKEN_PLACEHOLDER = '<your MCP token>';
const PACKAGE = '@mp-consulting/homebridge-ai-kit';

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, '\'\\\'\'')}'`;
}

/**
 * Snippets for Claude Desktop, Claude Code and Cursor. With `http` they use the
 * plugin's Streamable HTTP server; otherwise they launch the stdio server with npx.
 */
export function mcpClientSnippets(options: SnippetOptions): McpClientSnippets {
  if (options.http) {
    const host = ['0.0.0.0', '::', ''].includes(options.http.host) ? '127.0.0.1' : options.http.host;
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${options.http.port}/mcp`;
    const token = options.includeToken && options.http.token ? options.http.token : TOKEN_PLACEHOLDER;
    const headers = { Authorization: `Bearer ${token}` };
    return {
      // Claude Desktop only speaks stdio to local servers; mcp-remote bridges to HTTP.
      claudeDesktop: JSON.stringify(
        { mcpServers: { homebridge: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization:Bearer ${token}`] } } },
        null,
        2,
      ),
      claudeCode: `claude mcp add --transport http homebridge ${url} --header ${shellQuote(`Authorization: Bearer ${token}`)}`,
      cursor: JSON.stringify({ mcpServers: { homebridge: { url, headers } } }, null, 2),
    };
  }

  const env = { HOMEBRIDGE_URL: options.homebridgeUrl, HOMEBRIDGE_TOKEN: '<a Homebridge API token>' };
  const stdio = { command: 'npx', args: ['-y', PACKAGE, 'mcp'], env };
  return {
    claudeDesktop: JSON.stringify({ mcpServers: { homebridge: stdio } }, null, 2),
    claudeCode:
      `claude mcp add homebridge -e HOMEBRIDGE_URL=${shellQuote(env.HOMEBRIDGE_URL)} -e ${shellQuote(`HOMEBRIDGE_TOKEN=${env.HOMEBRIDGE_TOKEN}`)} ` +
      `-- npx -y ${PACKAGE} mcp`,
    cursor: JSON.stringify({ mcpServers: { homebridge: stdio } }, null, 2),
  };
}
