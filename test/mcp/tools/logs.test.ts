import { describe, it, expect, vi } from 'vitest';
import type { HomebridgeClient } from '../../../src/mcp/homebridge-client.js';
import { SEARCH_BUDGET_MS, register } from '../../../src/mcp/tools/logs.js';
import { collectHandlers } from '../helpers.js';

const ESC = '\u001B';

/** A log line as homebridge-config-ui-x writes it, with colour codes. */
function coloured(plugin: string, message: string): string {
  return `${ESC}[37m[9/8/2026, 2:03:58 AM]${ESC}[39m ${ESC}[36m[${plugin}]${ESC}[39m ${message}`;
}

function mockClient(log: string, truncated = false): HomebridgeClient {
  return {
    getLogTail: vi.fn().mockResolvedValue({ text: log, truncated }),
  } as unknown as HomebridgeClient;
}

function failingClient(error: Error): HomebridgeClient {
  return {
    getLogTail: vi.fn().mockRejectedValue(error),
  } as unknown as HomebridgeClient;
}

function extractToolHandlers(client: HomebridgeClient) {
  return collectHandlers(register, client);
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
      expect(client.getLogTail).not.toHaveBeenCalled();
    });

    it('reports errors from the client', async () => {
      const handlers = extractToolHandlers(failingClient(new Error('boom')));
      const result = await handlers.get('search_logs')!({ pattern: 'error' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error searching Homebridge log');
    });
  });

  describe('regex safety', () => {
    it('stops a catastrophically backtracking regex within the budget', async () => {
      // Without the worker this single line blocks the event loop for minutes.
      const log = `${'a'.repeat(40)}!\n`;
      const handlers = extractToolHandlers(mockClient(log));
      const started = Date.now();
      const result = await handlers.get('search_logs')!({ pattern: '^(a+)+$', regex: true });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`exceeded ${SEARCH_BUDGET_MS}ms`);
      expect(Date.now() - started).toBeLessThan(SEARCH_BUDGET_MS + 2000);
    }, SEARCH_BUDGET_MS + 5000);

    it('applies the case-insensitive flag inside the worker', async () => {
      const handlers = extractToolHandlers(mockClient('Warning: x\nok\n'));
      const result = await handlers.get('search_logs')!({ pattern: '^warn', regex: true });

      expect(result.content[0].text).toContain('Showing 1 of 1 match');
    });
  });

  describe('truncation', () => {
    it('drops the leading partial line of a truncated read', async () => {
      const handlers = extractToolHandlers(mockClient('xxxx partial\nlast line\n', true));
      const result = await handlers.get('get_recent_logs')!({});

      expect(result.content[0].text).toBe('Log is large; only the most recent 16 MB was read.\n\nlast line');
    });

    it('flags truncation in search results', async () => {
      const handlers = extractToolHandlers(mockClient('partial\nerror here\n', true));
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
