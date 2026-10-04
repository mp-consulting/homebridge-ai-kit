import { describe, expect, it } from 'vitest';
import { mcpClientSnippets } from '../../src/plugin/snippets.js';

describe('mcpClientSnippets', () => {
  it('builds stdio snippets with npx', () => {
    const s = mcpClientSnippets({ homebridgeUrl: 'http://192.168.1.10:8581' });
    const desktop = JSON.parse(s.claudeDesktop).mcpServers.homebridge;
    expect(desktop).toEqual({
      command: 'npx',
      args: ['-y', '@mp-consulting/homebridge-ai-kit', 'mcp'],
      env: { HOMEBRIDGE_URL: 'http://192.168.1.10:8581', HOMEBRIDGE_TOKEN: '<a Homebridge API token>' },
    });
    expect(JSON.parse(s.cursor)).toEqual(JSON.parse(s.claudeDesktop));
    expect(s.claudeCode).toBe(
      "claude mcp add homebridge -e HOMEBRIDGE_URL=http://192.168.1.10:8581 -e 'HOMEBRIDGE_TOKEN=<a Homebridge API token>' -- npx -y @mp-consulting/homebridge-ai-kit mcp",
    );
  });

  it('builds HTTP snippets with a placeholder token by default', () => {
    const s = mcpClientSnippets({ homebridgeUrl: 'x', http: { host: '0.0.0.0', port: 8582, token: "t'k" } });
    expect(JSON.parse(s.cursor)).toEqual({ mcpServers: { homebridge: { url: 'http://127.0.0.1:8582/mcp', headers: { Authorization: 'Bearer <your MCP token>' } } } });
    expect(JSON.parse(s.claudeDesktop).mcpServers.homebridge.args).toEqual(['-y', 'mcp-remote', 'http://127.0.0.1:8582/mcp', '--header', 'Authorization:Bearer <your MCP token>']);
    expect(s.claudeCode).toBe("claude mcp add --transport http homebridge http://127.0.0.1:8582/mcp --header 'Authorization: Bearer <your MCP token>'");
  });

  it('includes the real token on request and brackets IPv6 hosts', () => {
    const s = mcpClientSnippets({ homebridgeUrl: 'x', http: { host: 'fd00::1', port: 9000, token: "t'k" }, includeToken: true });
    expect(JSON.parse(s.cursor).mcpServers.homebridge).toEqual({ url: 'http://[fd00::1]:9000/mcp', headers: { Authorization: "Bearer t'k" } });
    expect(s.claudeCode).toContain("'Authorization: Bearer t'\\''k'");
    expect(mcpClientSnippets({ homebridgeUrl: 'x', http: { host: 'hb.local', port: 1 }, includeToken: true }).cursor).toContain('<your MCP token>');
  });
});
