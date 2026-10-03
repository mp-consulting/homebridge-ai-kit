import { z } from 'zod';
import type { HomebridgeClient } from '../homebridge-client.js';
import type { RegisterTools } from '../types.js';
import { RegexTimeoutError, regexSearch } from '../regex-search.js';
import { READ, errorResult, handle, textResult } from './helpers.js';

// The UI strips colour codes server-side, but a custom log path or an older UI
// can still return them, so strip defensively before matching *and* displaying.
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\u001B\[[0-9;]*m/g;

/** Cap on how much of the log we keep in memory, in bytes. The rest is streamed past. */
export const MAX_BYTES = 16 * 1024 * 1024;

/** Wall-clock budget for a regex search, so a pathological pattern can't hang the server. */
export const SEARCH_BUDGET_MS = 5000;

function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

interface LogLines {
  lines: string[];
  truncated: boolean;
}

/**
 * Fetch the log and return its most recent lines, ANSI-stripped. Lines are
 * stripped before they are handed back so that searching and displaying both
 * operate on the same text the user sees.
 */
async function readLogTail(client: HomebridgeClient): Promise<LogLines> {
  const { text, truncated } = await client.getLogTail(MAX_BYTES);
  const lines = splitLines(text).map(stripAnsi);

  // The first line of a truncated read is the tail end of an earlier line.
  if (truncated) {
    lines.shift();
  }

  return { lines, truncated };
}

function truncationNote(truncated: boolean): string {
  return truncated ? `Log is large; only the most recent ${MAX_BYTES / 1024 / 1024} MB was read.` : '';
}

export const register: RegisterTools = (tool, client) => {
  tool(
    'get_recent_logs',
    {
      title: 'Recent log lines',
      description: 'Return the most recent lines from the Homebridge log (ANSI-stripped). Requires an hb-service based Homebridge install.',
      inputSchema: {
        lines: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe('Number of lines to return from the tail (default 200, max 5000).'),
      },
      annotations: READ,
    },
    handle('reading Homebridge log', async ({ lines }) => {
      const n = lines ?? 200;
      const { lines: all, truncated } = await readLogTail(client);
      const body = all.slice(-n).join('\n');
      const note = truncationNote(truncated);
      return textResult(note && body ? `${note}\n\n${body}` : note || body);
    }),
  );

  tool(
    'search_logs',
    {
      title: 'Search logs',
      description:
        'Search the Homebridge log for matching lines. Returns up to `limit` most recent matches (ANSI-stripped). ' +
        'Useful for finding errors, warnings, or events involving a specific device.',
      inputSchema: {
        pattern: z.string().min(1).describe('Substring or regex pattern to match against each log line.'),
        regex: z
          .boolean()
          .optional()
          .describe('Treat pattern as a JavaScript regex (default: false, treats pattern as a literal substring).'),
        caseSensitive: z.boolean().optional().describe('Case-sensitive match (default: false).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe('Maximum matches to return, taken from the most recent (default 100, max 2000).'),
      },
      annotations: READ,
    },
    handle('searching Homebridge log', async ({ pattern, regex, caseSensitive, limit }) => {
      const max = limit ?? 100;
      const cs = caseSensitive ?? false;
      const flags = cs ? '' : 'i';
      const label = regex ? `/${pattern}/${flags}` : JSON.stringify(pattern) + (cs ? ' (case-sensitive)' : '');

      if (regex) {
        try {
          new RegExp(pattern, flags);
        } catch (error) {
          return errorResult(`Invalid regex ${label}: ${error}`);
        }
      }

      const { lines, truncated } = await readLogTail(client);

      let matches: string[];
      if (regex) {
        try {
          matches = (await regexSearch(lines, pattern, flags, SEARCH_BUDGET_MS)).map((i) => lines[i]);
        } catch (error) {
          if (error instanceof RegexTimeoutError) {
            return errorResult(
              `Search for ${label} exceeded ${SEARCH_BUDGET_MS}ms and was stopped. Try a simpler pattern or a literal substring.`,
            );
          }
          throw error;
        }
      } else {
        // Substring search is linear, so it is safe on the main thread.
        const needle = cs ? pattern : pattern.toLowerCase();
        matches = lines.filter((line) => (cs ? line : line.toLowerCase()).includes(needle));
      }

      const taken = matches.slice(-max);
      const parts = [`Showing ${taken.length} of ${matches.length} match${matches.length === 1 ? '' : 'es'} for ${label}.`];
      const note = truncationNote(truncated);
      if (note) {
        parts.push(note);
      }
      const header = parts.join(' ');
      const body = taken.join('\n');
      return textResult(body ? `${header}\n\n${body}` : header);
    }),
  );
};
