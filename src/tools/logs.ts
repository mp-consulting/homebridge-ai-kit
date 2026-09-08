import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HomebridgeClient } from '../homebridge-client.js';
import { z } from 'zod';

// The UI strips colour codes server-side, but a custom log path or an older UI
// can still return them, so strip defensively before matching *and* displaying.
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\u001B\[[0-9;]*m/g;

/** Cap on how much of the log we keep in memory, in characters. */
const MAX_CHARS = 16 * 1024 * 1024;

/** Wall-clock budget for a search, so a pathological regex can't hang the server. */
const SEARCH_BUDGET_MS = 5000;

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

interface LogTail {
  lines: string[];
  truncated: boolean;
}

/**
 * Fetch the log and return its most recent lines, ANSI-stripped. Lines are
 * stripped before they are handed back so that searching and displaying both
 * operate on the same text the user sees.
 */
async function readLogTail(client: HomebridgeClient): Promise<LogTail> {
  const raw = await client.getLogFile();
  const truncated = raw.length > MAX_CHARS;
  const lines = splitLines(truncated ? raw.slice(raw.length - MAX_CHARS) : raw).map(stripAnsi);

  // The first line of a truncated read is the tail end of an earlier line.
  if (truncated) {
    lines.shift();
  }

  return { lines, truncated };
}

function truncationNote(truncated: boolean): string {
  return truncated ? `Log is large; only the most recent ${MAX_CHARS / 1024 / 1024} MB was read.` : '';
}

export function register(server: McpServer, client: HomebridgeClient): void {
  server.tool(
    'get_recent_logs',
    'Return the most recent lines from the Homebridge log (ANSI-stripped). Requires an hb-service based Homebridge install.',
    {
      lines: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe('Number of lines to return from the tail (default 200, max 5000).'),
    },
    async ({ lines }) => {
      try {
        const n = lines ?? 200;
        const { lines: all, truncated } = await readLogTail(client);
        const body = all.slice(-n).join('\n');
        const note = truncationNote(truncated);
        return {
          content: [{ type: 'text', text: note && body ? `${note}\n\n${body}` : note || body }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error reading Homebridge log: ${error}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'search_logs',
    'Search the Homebridge log for matching lines. Returns up to `limit` most recent matches (ANSI-stripped). Useful for finding errors, warnings, or events involving a specific device.',
    {
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
    async ({ pattern, regex, caseSensitive, limit }) => {
      const max = limit ?? 100;
      const cs = caseSensitive ?? false;
      const label = regex
        ? `/${pattern}/${cs ? '' : 'i'}`
        : JSON.stringify(pattern) + (cs ? ' (case-sensitive)' : '');

      let test: (line: string) => boolean;
      if (regex) {
        let re: RegExp;
        try {
          re = new RegExp(pattern, cs ? '' : 'i');
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Invalid regex ${label}: ${error}` }],
            isError: true,
          };
        }
        test = (line) => re.test(line);
      } else {
        const needle = cs ? pattern : pattern.toLowerCase();
        test = (line) => (cs ? line : line.toLowerCase()).includes(needle);
      }

      try {
        const { lines, truncated } = await readLogTail(client);
        const matches: string[] = [];
        const deadline = Date.now() + SEARCH_BUDGET_MS;

        for (const line of lines) {
          if (Date.now() > deadline) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Search for ${label} exceeded ${SEARCH_BUDGET_MS}ms and was stopped. Try a simpler pattern or a literal substring.`,
                },
              ],
              isError: true,
            };
          }
          if (test(line)) {
            matches.push(line);
          }
        }

        const taken = matches.slice(-max);
        const parts = [
          `Showing ${taken.length} of ${matches.length} match${matches.length === 1 ? '' : 'es'} for ${label}.`,
        ];
        const note = truncationNote(truncated);
        if (note) {
          parts.push(note);
        }
        const header = parts.join(' ');
        const body = taken.join('\n');
        return {
          content: [{ type: 'text', text: body ? `${header}\n\n${body}` : header }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error searching Homebridge log: ${error}` }],
          isError: true,
        };
      }
    },
  );
}
