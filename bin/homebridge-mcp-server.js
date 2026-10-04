#!/usr/bin/env node

// @mp-consulting/homebridge-mcp-server is now @mp-consulting/homebridge-ai-kit.
// This last release only runs the new package, so existing MCP client configs keep working.
import { runStdioServer } from '@mp-consulting/homebridge-ai-kit/mcp'

console.error('homebridge-mcp-server: this package is now @mp-consulting/homebridge-ai-kit; install it and use `homebridge-ai-kit mcp`.')
await runStdioServer('homebridge-mcp-server')
