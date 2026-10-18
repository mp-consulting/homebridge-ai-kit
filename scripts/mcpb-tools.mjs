// Prints the MCP server's tools as the `tools` array of an .mcpb manifest: [{ name, description }].
// Run `npm run build` first. Lists every tool (not read-only mode); listing sends no request to Homebridge.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HomebridgeClient, createServer } from '../dist/mcp/index.js';
import process from 'node:process';

const client = new HomebridgeClient({ url: 'http://127.0.0.1:8581', token: 'unused' });
const server = createServer(client, { readOnly: false, elicitation: false, live: false });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const mcp = new Client({ name: 'mcpb-tools', version: '1.0.0' });
await mcp.connect(clientTransport);
const { tools } = await mcp.listTools();
await mcp.close();
process.stdout.write(JSON.stringify(tools.map(({ name, description }) => ({ name, description }))));
