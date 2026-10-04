# @mp-consulting/homebridge-mcp-server

**This package has been renamed to [`@mp-consulting/homebridge-ai-kit`](https://www.npmjs.com/package/@mp-consulting/homebridge-ai-kit).**

Version 1.3.0 is the last release. It installs the new package and runs its MCP server, so an existing `homebridge-mcp-server` entry in Claude Desktop, Claude Code or Cursor keeps working with the same environment variables.

To switch:

```bash
npm uninstall -g @mp-consulting/homebridge-mcp-server
npm install -g @mp-consulting/homebridge-ai-kit
```

Then use `homebridge-ai-kit mcp` as the command in new MCP client configs. The new package still provides a `homebridge-mcp-server` command as well.
