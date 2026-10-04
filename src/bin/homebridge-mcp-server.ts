#!/usr/bin/env node

// Kept so MCP client configs written for the old package name keep working.
import { runStdioServer } from '../mcp/stdio.js';

await runStdioServer('homebridge-mcp-server');
