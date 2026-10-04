import { describe, it, expect, vi } from 'vitest';
import { compactHistory, downsample, register, summarize } from '../../../src/mcp/tools/history.js';
import { collectTools, mockClient } from '../helpers.js';

// ── Helpers ────────────────────────────────────────────────────

const HOUR = 3_600_000;
const FROM = Date.UTC(2026, 9, 3, 18, 0);
const TO = FROM + 12 * HOUR;

/** A living room that cooled overnight: 21° at 18:00, 16.5° at 03:00, 19° at 06:00. */
function makeHistory(overrides: Record<string, unknown> = {}) {
  return {
    uniqueId: 'acc-1',
    from: FROM,
    to: TO,
    series: [
      {
        type: 'CurrentTemperature',
        description: 'Current Temperature',
        unit: 'celsius',
        points: [
          [FROM, 21],
          [FROM + 6 * HOUR, 18],
          [FROM + 9 * HOUR, 16.5],
          [FROM + 11 * HOUR, 19],
        ] as Array<[number, number]>,
      },
    ],
    ...overrides,
  };
}

function setup(getAccessoryHistory: unknown = vi.fn().mockResolvedValue(makeHistory())) {
  const client = mockClient({ getAccessoryHistory });
  const tools = collectTools(register, client);
  return { client, tool: tools.get('get_accessory_history')! };
}

async function call(args: Record<string, unknown>, history?: unknown) {
  const { client, tool } = setup(history);
  const result = await tool.handler(args);
  return { client, result, parsed: result.isError ? undefined : JSON.parse(result.content[0].text) };
}

// ── Tests ──────────────────────────────────────────────────────

describe('get_accessory_history', () => {
  it('is a read-only tool', () => {
    const { tool } = setup();
    expect(tool.config.annotations).toMatchObject({ readOnlyHint: true });
    expect(tool.config.title).toBe('Get accessory history');
  });

  it('asks Glass UI for every point and defaults to the last 24 hours', async () => {
    const { client } = await call({ uniqueId: 'acc-1' });
    expect(client.getAccessoryHistory).toHaveBeenCalledWith('acc-1', { hours: 24, type: undefined, maxPoints: 5000 });
  });

  it('passes hours and type through', async () => {
    const { client } = await call({ uniqueId: 'acc-1', hours: 12, type: 'CurrentTemperature', maxPoints: 10 });
    expect(client.getAccessoryHistory).toHaveBeenCalledWith('acc-1', { hours: 12, type: 'CurrentTemperature', maxPoints: 5000 });
  });

  it('summarizes each series with min, max, time-weighted average and last value', async () => {
    const { parsed, result } = await call({ uniqueId: 'acc-1', hours: 12 });

    expect(result.content[0].text).not.toContain('\n');
    expect(parsed).toEqual({
      uniqueId: 'acc-1',
      from: '2026-10-03T18:00Z',
      to: '2026-10-04T06:00Z',
      hours: 12,
      series: [
        {
          type: 'CurrentTemperature',
          description: 'Current Temperature',
          unit: 'celsius',
          count: 4,
          min: { value: 16.5, at: '2026-10-04T03:00Z' },
          max: { value: 21, at: '2026-10-03T18:00Z' },
          // 21 for 6 h, 18 for 3 h, 16.5 for 2 h, 19 for 1 h
          avg: 19.33,
          last: { value: 19, at: '2026-10-04T05:00Z' },
          points: [
            ['2026-10-03T18:00Z', 21],
            ['2026-10-04T00:00Z', 18],
            ['2026-10-04T03:00Z', 16.5],
            ['2026-10-04T05:00Z', 19],
          ],
        },
      ],
    });
  });

  it('averages the points down to maxPoints but keeps the summary exact', async () => {
    const points = Array.from({ length: 100 }, (_, i): [number, number] => [FROM + i * 60_000, i === 42 ? -5 : 20]);
    const history = makeHistory({ series: [{ type: 'CurrentTemperature', points }] });
    const { parsed } = await call({ uniqueId: 'acc-1', maxPoints: 5 }, vi.fn().mockResolvedValue(history));
    const [series] = parsed.series;

    expect(series.points).toHaveLength(5);
    expect(series.min).toEqual({ value: -5, at: '2026-10-03T18:42Z' });
    expect(series).not.toHaveProperty('unit');
    expect(series).not.toHaveProperty('description');
  });

  it('explains an empty history', async () => {
    const { parsed } = await call({ uniqueId: 'acc-1' }, vi.fn().mockResolvedValue(makeHistory({ series: [{ type: 'BatteryLevel', points: [] }] })));

    expect(parsed.series).toEqual([]);
    expect(parsed.note).toContain('No values were recorded');
  });

  it('says the history needs Glass UI when the endpoint is missing', async () => {
    const { result } = await call({ uniqueId: 'acc-1' }, vi.fn().mockRejectedValue(new Error('Homebridge API error 404 GET /api/accessories/acc-1/history: Not Found')));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'Error getting accessory history: Homebridge API error 404 GET /api/accessories/acc-1/history: Not Found (accessory history needs Homebridge Glass UI)',
    );
  });

  it('reports other errors as they are', async () => {
    const { result } = await call({ uniqueId: 'acc-1' }, vi.fn().mockRejectedValue(new Error('Homebridge API error 400 GET /x: hours must be between 1 and 8760.')));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error getting accessory history: Homebridge API error 400 GET /x: hours must be between 1 and 8760.');
  });
});

describe('history helpers', () => {
  it('downsample leaves short series alone and averages long ones into time buckets', () => {
    const short: Array<[number, number]> = [[0, 1], [10, 2]];
    expect(downsample(short, 5)).toBe(short);
    expect(downsample([[0, 1], [1, 3], [10, 5], [11, 7]], 2)).toEqual([[1, 2], [11, 6]]);
  });

  it('summarize falls back to a plain mean when no time has passed', () => {
    expect(summarize([[TO, 4], [TO, 6]], TO)).toMatchObject({ count: 2, avg: 5, last: { value: 6 } });
  });

  it('compactHistory rounds values', () => {
    const history = makeHistory({ series: [{ type: 'CurrentRelativeHumidity', points: [[FROM, 45.123456]] }] });
    expect(compactHistory(history, 12, 48).series[0]).toMatchObject({ min: { value: 45.12 }, points: [['2026-10-03T18:00Z', 45.12]] });
  });
});
