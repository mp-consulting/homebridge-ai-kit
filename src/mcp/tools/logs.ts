import { z } from 'zod';
import type { HomebridgeClient } from '../homebridge-client.js';
import type { RegisterTools } from '../types.js';
import { RegexTimeoutError, regexSearch } from '../regex-search.js';
import { READ, errorMessage, errorResult, handle, textResult, untrusted } from './helpers.js';
import { LOG_SEARCH } from './output-schemas.js';
import { atLeast, parseLogLines, parseTimeBound } from '../log-parse.js';

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
      return textResult(note && body ? `${note}\n\n${untrusted('homebridge-log', body)}` : note || (body && untrusted('homebridge-log', body)));
    }),
  );

  tool(
    'search_logs',
    {
      title: 'Search logs',
      description:
        'Search the Homebridge log. Returns up to `limit` most recent matching lines (ANSI-stripped), optionally with `context` lines around each. ' +
        'Narrow by time (`since`/`until`: ISO or a duration back from now like 30m, 1h, 2d; log times are the Homebridge server\'s local time), ' +
        'by minimum `level` (error > warn > info > debug, read from the log colours) and by `plugin` (the [Prefix] after the timestamp, ' +
        'usually the platform or accessory name). `pattern` is optional when a filter is given.',
      inputSchema: {
        pattern: z.string().min(1).optional().describe('Substring or regex pattern to match against each log line. Omit to match every line that passes the filters.'),
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
        since: z.string().min(1).optional().describe("Only lines at or after this time: ISO (2026-10-04T18:00) or a duration back from now ('1h', '30m', '2d')."),
        until: z.string().min(1).optional().describe('Only lines at or before this time, same formats as since.'),
        level: z.enum(['error', 'warn', 'info', 'debug']).optional().describe("Minimum level: 'warn' returns warnings and errors."),
        plugin: z.string().min(1).optional().describe("Only lines whose [Prefix] contains this (case-insensitive), e.g. 'Hue' or 'Homebridge UI'."),
        context: z.number().int().min(0).max(20).optional().describe('Lines of context to show before and after each match (default 0).'),
      },
      outputSchema: LOG_SEARCH,
      annotations: READ,
    },
    handle('searching Homebridge log', async ({ pattern, regex, caseSensitive, limit, since, until, level, plugin, context }) => {
      const max = limit ?? 100;
      const cs = caseSensitive ?? false;
      const flags = cs ? '' : 'i';
      const filters = [
        since && `since ${since}`,
        until && `until ${until}`,
        level && `level ≥ ${level}`,
        plugin && `plugin ~ ${JSON.stringify(plugin)}`,
      ].filter(Boolean);
      const what = pattern === undefined ? 'all lines' : regex ? `/${pattern}/${flags}` : JSON.stringify(pattern) + (cs ? ' (case-sensitive)' : '');
      const label = filters.length ? `${what} (${filters.join(', ')})` : what;

      if (pattern !== undefined && regex) {
        try {
          new RegExp(pattern, flags);
        } catch (error) {
          return errorResult(`Invalid regex /${pattern}/${flags}: ${error}`);
        }
      }
      let sinceMs: number | undefined;
      let untilMs: number | undefined;
      try {
        sinceMs = since === undefined ? undefined : parseTimeBound(since);
        untilMs = until === undefined ? undefined : parseTimeBound(until);
      } catch (error) {
        return errorResult(errorMessage(error));
      }

      // Colour is only asked for when the level matters: it is where Homebridge shows it.
      const { text, truncated } = await client.getLogTail(MAX_BYTES, level ? { colour: true } : {});
      const raw = splitLines(text);
      if (truncated) {
        raw.shift();
      }
      const entries = parseLogLines(raw);
      const needle = pattern !== undefined && !cs ? pattern.toLowerCase() : pattern;
      const candidates: number[] = [];
      entries.forEach((e, i) => {
        if (
          (sinceMs === undefined || (e.time !== undefined && e.time >= sinceMs)) &&
          (untilMs === undefined || (e.time !== undefined && e.time <= untilMs)) &&
          (!level || atLeast(e.level, level)) &&
          (!plugin || e.prefix?.toLowerCase().includes(plugin.toLowerCase())) &&
          // Substring search is linear, so it is safe on the main thread.
          (needle === undefined || regex || (cs ? e.text : e.text.toLowerCase()).includes(needle))
        ) {
          candidates.push(i);
        }
      });

      let matches = candidates;
      if (pattern !== undefined && regex) {
        try {
          matches = (await regexSearch(candidates.map((i) => entries[i].text), pattern, flags, SEARCH_BUDGET_MS)).map((k) => candidates[k]);
        } catch (error) {
          if (error instanceof RegexTimeoutError) {
            return errorResult(
              `Search for ${label} exceeded ${SEARCH_BUDGET_MS}ms and was stopped. Try a simpler pattern or a literal substring.`,
            );
          }
          throw error;
        }
      }

      const taken = matches.slice(-max);
      const parts = [`Showing ${taken.length} of ${matches.length} match${matches.length === 1 ? '' : 'es'} for ${label}.`];
      const note = truncationNote(truncated);
      if (note) {
        parts.push(note);
      }
      const header = parts.join(' ');
      const body = context ? withContext(entries.map((e) => e.text), taken, context) : taken.map((i) => entries[i].text).join('\n');
      const structured = {
        total: matches.length,
        shown: taken.length,
        truncated,
        matches: taken.map((i) => {
          const e = entries[i];
          return { line: i + 1, time: e.time === undefined ? null : new Date(e.time).toISOString(), level: e.level, plugin: e.prefix ?? null, text: e.text };
        }),
      };
      return { ...textResult(body ? `${header}\n\n${untrusted('homebridge-log', body)}` : header), structuredContent: structured };
    }),
  );
};

/** grep -C style: matched lines marked `>`, context lines indented, separate groups split by `--`. */
export function withContext(lines: string[], matches: number[], context: number): string {
  const hit = new Set(matches);
  const out: string[] = [];
  let shownUntil = -1;
  for (const index of matches) {
    const from = Math.max(index - context, shownUntil + 1);
    const to = Math.min(index + context, lines.length - 1);
    if (out.length && from > shownUntil + 1) {
      out.push('--');
    }
    for (let i = from; i <= to; i++) {
      out.push(`${hit.has(i) ? '>' : ' '} ${lines[i]}`);
    }
    shownUntil = Math.max(shownUntil, to);
  }
  return out.join('\n');
}
