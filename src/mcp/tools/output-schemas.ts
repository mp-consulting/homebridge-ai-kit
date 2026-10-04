import { z } from 'zod';

/**
 * `outputSchema` shapes for the tools that return `structuredContent`. Deliberately loose:
 * Homebridge UI versions add and drop fields, and a result that fails its schema becomes an error.
 */

const str = z.string().nullish();

const accessorySummary = z.looseObject({
  uniqueId: z.string(),
  serviceName: str,
  type: str,
  manufacturer: str,
  model: str,
  values: z.record(z.string(), z.unknown()).optional(),
});

export const ACCESSORY_LIST = z.looseObject({ accessories: z.array(accessorySummary) });

export const ACCESSORY = z.looseObject({
  uniqueId: z.string().optional(),
  serviceName: str,
  type: str,
  accessoryInformation: z.record(z.string(), z.unknown()).optional(),
  serviceCharacteristics: z.array(z.looseObject({ type: z.string() })).optional(),
  values: z.record(z.string(), z.unknown()).optional(),
});

export const PLUGIN_LIST = z.looseObject({
  plugins: z.array(
    z.looseObject({
      name: z.string(),
      displayName: str,
      installedVersion: str,
      latestVersion: str,
      updateAvailable: z.boolean().nullish(),
      disabled: z.boolean().nullish(),
    }),
  ),
});

export const CHILD_BRIDGE_LIST = z.looseObject({
  childBridges: z.array(z.looseObject({ username: z.string(), name: str, plugin: str, status: str, manuallyStopped: z.boolean().nullish() })),
});

export const CHILD_BRIDGE_HEALTH = z.looseObject({
  crashLoop: z.looseObject({ crashes: z.number(), windowMinutes: z.number() }).optional(),
  bridges: z.array(
    z.looseObject({
      username: z.string(),
      name: str,
      status: str,
      uptime: z.number().nullish(),
      restartCount: z.number().optional(),
      crashCount: z.number().optional(),
      crashLoop: z.boolean().optional(),
    }),
  ),
});

/** `GET /api/status/homebridge` and server information: free-form objects, `status` when present. Top levels are loose too. */
export const STATUS = z.looseObject({ status: str });

export const SERVER_INFO = z.looseObject({});

export const LOG_SEARCH = z.looseObject({
  total: z.number().describe('Matching lines in the part of the log that was read'),
  shown: z.number(),
  truncated: z.boolean().describe('Only the most recent part of a large log was read'),
  matches: z.array(
    z.object({
      line: z.number().describe('1-based line number in the part of the log that was read'),
      time: z.string().nullable().describe('ISO time from the line (server local time read as local)'),
      level: z.enum(['error', 'warn', 'info', 'debug']),
      plugin: z.string().nullable(),
      text: z.string(),
    }),
  ),
});

export const SCENE_LIST = z.looseObject({
  scenes: z.array(z.looseObject({ id: z.string(), name: z.string(), actions: z.array(z.looseObject({})).optional() })),
});
