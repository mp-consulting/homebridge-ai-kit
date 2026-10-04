#!/usr/bin/env node

import { runStdioServer } from '../mcp/stdio.js';

const USAGE = `Usage: homebridge-ai-kit <command>

Commands:
  mcp    Run the Homebridge MCP server on stdio`;

const [command] = process.argv.slice(2);

switch (command) {
  case 'mcp':
    await runStdioServer('homebridge-ai-kit');
    break;
  case undefined:
  case '-h':
  case '--help':
    console.error(USAGE);
    process.exit(command === undefined ? 1 : 0);
    break;
  default:
    console.error(`homebridge-ai-kit: unknown command '${command}'\n\n${USAGE}`);
    process.exit(1);
}
