import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomebridgeClient } from '../../src/homebridge-client.js';
import { register } from '../../src/tools/logs.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const ESC = '\u001B';

/** A log line as homebridge-config-ui-x writes it, with colour codes. */
function coloured(plugin: string, message: string): string {
  return `${ESC}[37m[9/8/2026, 2:03:58 AM]${ESC}[39m ${ESC}[36m[${plugin}]${ESC}[39m ${message}`;
}

function mockClient(log: string): HomebridgeClient {
  return {
    getLogFile: vi.fn().mockResolvedValue(log),
  } as unknown as HomebridgeClient;
}

function failingClient(error: Error): HomebridgeClient {
  return {
    getLogFile: vi.fn().mockRejectedValue(error),
  } as unknown as HomebridgeClient;
}

function extractToolHandlers(client: HomebridgeClient) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const handlers = new Map<string, ToolHandler>();
  const origTool = server.tool.bind(server);

  vi.spyOn(server, 'tool').mockImplementation((...args: unknown[]) => {
    const handler = args[args.length - 1] as ToolHandler;
    const name = args[0] as string;
    handlers.set(name, handler);
    return origTool(...(args as Parameters<typeof origTool>));
  });

  register(server, client);
  return handlers;
}

describe('log tools', () => {
  describe('get_recent_logs', () => {
    it('returns the tail of the log', async () => {
      const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n';
      const handlers = extractToolHandlers(mockClient(log));
      const result = await handlers.get('get_recent_logs')!({ lines: 3 });

      expect(result.content[0].text).toBe('line 497\nline 498\nline 499');
    });

    it('defaults to 200 lines', async () => {
      const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n';
      const handlers = extractToolHandlers(mockClient(log));
      const result = await handlers.get('get_recent_logs')!({});

      expect(result.content[0].text.split('\n')).toHaveLength(200);
    });

    it('strips ANSI colour codes', async () => {
      const handlers = extractToolHandlers(mockClient(coloured('homebridge-govee', 'Error: unreachable') + '\n'));
      const result = await handlers.get('get_recent_logs')!({});

      expect(result.content[0].text).toBe('[9/8/2026, 2:03:58 AM] [homebridge-govee] Error: unreachable');
    });

    it('handles an empty log', async () => {
      const handlers = extractToolHandlers(mockClient(''));
      const result = await handlers.get('get_recent_logs')!({});

      expect(result.content[0].text).toBe('');
      expect(result.isError).toBeUndefined();
    });

    it('reports errors from the client', async () => {
      const handlers = extractToolHandlers(failingClient(new Error('Log file not found on disk.')));
      const result = await handlers.get('get_recent_logs')!({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error reading Homebridge log');
      expect(result.content[0].text).toContain('Log file not found on disk.');
    });
  });

  describe('search_logs', () => {
    it('matches a literal substring across colour codes', async () => {
      // The colour reset sits between the plugin name and the message, so this
      // only matches if lines are stripped before they are searched.
      const log = [coloured('homebridge-govee', 'Error: unreachable'), 'unrelated line'].join('\n') + '\n';
      const handlers = extractToolHandlers(mockClient(log));
      const result = await handlers.get('search_logs')!({ pattern: '[homebridge-govee] Error' });

      expect(result.content[0].text).toContain('Showing 1 of 1 match');
      expect(result.content[0].text).toContain('[9/8/2026, 2:03:58 AM] [homebridge-govee] Error: unreachable');
    });

    it('anchors a regex at the real start of the line', async () => {
      const log = coloured('homebridge-govee', 'Error: unreachable') + '\n';
      const handlers = extractToolHandlers(mockClient(log));
      const result = await handlers.get('search_logs')!({ pattern: '^\\[9/8', regex: true });

      expect(result.content[0].text).toContain('Showing 1 of 1 match');
    });

    it('is case-insensitive by default', async () => {
      const handlers = extractToolHandlers(mockClient('ERROR: boom\nquiet\n'));
      const result = await handlers.get('search_logs')!({ pattern: 'error' });

      expect(result.content[0].text).toContain('Showing 1 of 1 match');
    });

    it('honours caseSensitive', async () => {
      const handlers = extractToolHandlers(mockClient('ERROR: boom\nquiet\n'));
      const result = await handlers.get('search_logs')!({ pattern: 'error', caseSensitive: true });

      expect(result.content[0].text).toContain('Showing 0 of 0 matches');
      expect(result.content[0].text).toContain('(case-sensitive)');
    });

    it('returns the most recent matches up to limit', async () => {
      const log = Array.from({ length: 10 }, (_, i) => `error ${i}`).join('\n') + '\n';
      const handlers = extractToolHandlers(mockClient(log));
      const result = await handlers.get('search_logs')!({ pattern: 'error', limit: 2 });

      expect(result.content[0].text).toContain('Showing 2 of 10 matches');
      expect(result.content[0].text).toContain('error 8\nerror 9');
    });

    it('reports no matches without a body', async () => {
      const handlers = extractToolHandlers(mockClient('nothing here\n'));
      const result = await handlers.get('search_logs')!({ pattern: 'missing' });

      expect(result.content[0].text).toBe('Showing 0 of 0 matches for "missing".');
    });

    it('rejects an invalid regex without reading the log', async () => {
      const client = mockClient('anything\n');
      const handlers = extractToolHandlers(client);
      const result = await handlers.get('search_logs')!({ pattern: '(unclosed', regex: true });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid regex');
      expect(client.getLogFile).not.toHaveBeenCalled();
    });

    it('reports errors from the client', async () => {
      const handlers = extractToolHandlers(failingClient(new Error('boom')));
      const result = await handlers.get('search_logs')!({ pattern: 'error' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error searching Homebridge log');
    });
  });

  describe('truncation', () => {
    const MAX_CHARS = 16 * 1024 * 1024;

    it('keeps only the tail and drops the leading partial line', async () => {
      const filler = 'x'.repeat(MAX_CHARS);
      const log = `${filler}\nlast line\n`;
      const handlers = extractToolHandlers(mockClient(log));
      const result = await handlers.get('get_recent_logs')!({});

      expect(result.content[0].text).toContain('only the most recent 16 MB was read');
      // The truncated head of the filler line is dropped, not shown as garbage.
      expect(result.content[0].text).toContain('last line');
      expect(result.content[0].text).not.toContain('xxxx');
    });

    it('flags truncation in search results', async () => {
      const log = 'x'.repeat(MAX_CHARS) + '\nerror here\n';
      const handlers = extractToolHandlers(mockClient(log));
      const result = await handlers.get('search_logs')!({ pattern: 'error' });

      expect(result.content[0].text).toContain('Showing 1 of 1 match');
      expect(result.content[0].text).toContain('only the most recent 16 MB was read');
    });

    it('does not flag truncation for a small log', async () => {
      const handlers = extractToolHandlers(mockClient('short\n'));
      const result = await handlers.get('get_recent_logs')!({});

      expect(result.content[0].text).toBe('short');
    });
  });
});
