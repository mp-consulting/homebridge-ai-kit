#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { runHttpFromEnv, runStdioServer } from '../mcp/stdio.js';

const PROG = 'homebridge-ai-kit';

const USAGE = `Usage: ${PROG} mcp [--http [--port 8582] [--host 127.0.0.1]]

Commands:
  mcp            Run the Homebridge MCP server on stdio
  mcp --http     Serve MCP over Streamable HTTP instead (needs HOMEBRIDGE_AI_MCP_TOKEN)

Options:
  --port <n>     HTTP port (default 8582)
  --host <addr>  HTTP bind address (default 127.0.0.1)`;

let parsed: ReturnType<typeof parse>;
function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      http: { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

try {
  parsed = parse();
} catch (error) {
  console.error(`${PROG}: ${(error as Error).message}\n\n${USAGE}`);
  process.exit(1);
}

const { values, positionals } = parsed;
const [command] = positionals;

if (values.help) {
  console.error(USAGE);
  process.exit(0);
}

switch (command) {
  case 'mcp':
    if (values.http) {
      const port = values.port === undefined ? undefined : Number(values.port);
      if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
        console.error(`${PROG}: --port must be a port number, got ${values.port}`);
        process.exit(1);
      }
      await runHttpFromEnv(PROG, { port, host: values.host });
    } else {
      await runStdioServer(PROG);
    }
    break;
  case undefined:
    console.error(USAGE);
    process.exit(1);
    break;
  default:
    console.error(`${PROG}: unknown command '${command}'\n\n${USAGE}`);
    process.exit(1);
}
