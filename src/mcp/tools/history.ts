import { z } from 'zod';
import type { AccessoryHistory, RegisterTools } from '../types.js';
import { READ, errorMessage, handle, jsonResult } from './helpers.js';

/** Glass UI keeps at most 365 days of history. */
const MAX_HOURS = 24 * 365;
/** Asked of Glass UI (its maximum), so min/max/avg come from (nearly) every sample. */
const FETCH_POINTS = 5000;
const DEFAULT_POINTS = 48;
const MAX_POINTS = 500;

const NO_HISTORY =
  'No values were recorded for this accessory in this period. Glass UI records temperature, humidity, light level, battery, ' +
  'air quality, power and energy readings, needs Homebridge in insecure mode, and keeps them for accessoryHistory.retentionDays (7 by default).';

type Point = [number, number];

/** `2026-10-04T03:15Z`: minute precision is plenty and saves tokens. */
function at(t: number): string {
  return `${new Date(t).toISOString().slice(0, 16)}Z`;
}

function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Average `points` into at most `maxPoints` buckets of equal time (as Glass UI does). */
export function downsample(points: Point[], maxPoints: number): Point[] {
  if (points.length <= maxPoints) {
    return points;
  }
  const from = points[0][0];
  const span = points.at(-1)![0] - from + 1;
  const buckets = new Map<number, { t: number; sum: number; n: number }>();
  for (const [t, v] of points) {
    const index = Math.min(maxPoints - 1, Math.floor(((t - from) / span) * maxPoints));
    const bucket = buckets.get(index) ?? { t: 0, sum: 0, n: 0 };
    bucket.t += t;
    bucket.sum += v;
    bucket.n++;
    buckets.set(index, bucket);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([, { t, sum, n }]) => [Math.round(t / n), sum / n]);
}

/**
 * Min, max, last and a time-weighted average of one series. Values are recorded
 * when they change, so each one holds until the next (the last one until `to`).
 */
export function summarize(points: Point[], to: number) {
  let min = points[0];
  let max = points[0];
  let weighted = 0;
  let duration = 0;
  points.forEach(([t, v], i) => {
    if (v < min[1]) {
      min = points[i];
    }
    if (v > max[1]) {
      max = points[i];
    }
    const held = Math.max(0, (points[i + 1]?.[0] ?? to) - t);
    weighted += v * held;
    duration += held;
  });
  const last = points.at(-1)!;
  const avg = duration > 0 ? weighted / duration : points.reduce((sum, [, v]) => sum + v, 0) / points.length;
  return {
    count: points.length,
    min: { value: round(min[1]), at: at(min[0]) },
    max: { value: round(max[1]), at: at(max[0]) },
    avg: round(avg),
    last: { value: round(last[1]), at: at(last[0]) },
  };
}

/** The compact form returned to the model: a summary per series plus its downsampled points. */
export function compactHistory(history: AccessoryHistory, hours: number, maxPoints: number) {
  const series = history.series
    .filter((s) => s.points.length > 0)
    .map((s) => ({
      type: s.type,
      ...(s.description ? { description: s.description } : {}),
      ...(s.unit ? { unit: s.unit } : {}),
      ...summarize(s.points, history.to),
      points: downsample(s.points, maxPoints).map(([t, v]): [string, number] => [at(t), round(v)]),
    }));
  return {
    uniqueId: history.uniqueId,
    from: at(history.from),
    to: at(history.to),
    hours,
    series,
    ...(series.length ? {} : { note: NO_HISTORY }),
  };
}

export const register: RegisterTools = (tool, client) => {
  tool(
    'get_accessory_history',
    {
      title: 'Get accessory history',
      description:
        'Recorded sensor values of an accessory over time: temperature, humidity, light level, battery, air quality, power and energy. ' +
        'Returns, per characteristic, min / max (with when), the time-weighted average, the last value and the points averaged down to maxPoints. ' +
        'Times are UTC. Use it for questions like "why was the living room cold last night". Use list_accessories first to find the uniqueId. ' +
        'Needs Homebridge Glass UI.',
      inputSchema: {
        uniqueId: z.string().min(1).describe('The unique identifier of the accessory'),
        hours: z.number().positive().max(MAX_HOURS).optional().describe('How far back to look, in hours (default 24)'),
        type: z
          .string()
          .regex(/^[\w.-]{1,64}$/, 'A characteristic type such as CurrentTemperature')
          .optional()
          .describe("Only this characteristic (e.g. 'CurrentTemperature', 'CurrentRelativeHumidity', 'BatteryLevel'). Default: all recorded ones"),
        maxPoints: z
          .number()
          .int()
          .min(2)
          .max(MAX_POINTS)
          .optional()
          .describe(`Points per series after averaging (default ${DEFAULT_POINTS}). The summary always uses every recorded value`),
      },
      annotations: READ,
    },
    handle('getting accessory history', async ({ uniqueId, hours = 24, type, maxPoints = DEFAULT_POINTS }) => {
      let history: AccessoryHistory;
      try {
        history = await client.getAccessoryHistory(uniqueId, { hours, type, maxPoints: FETCH_POINTS });
      } catch (error) {
        // Glass UI answers an unknown uniqueId with no series; a 404 means the
        // endpoint itself is missing (homebridge-config-ui-x has none).
        if (/ error 404 /.test(errorMessage(error))) {
          throw new Error(`${errorMessage(error)} (accessory history needs Homebridge Glass UI)`, { cause: error });
        }
        throw error;
      }
      return jsonResult(compactHistory(history, hours, maxPoints));
    }),
  );
};
