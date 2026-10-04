import { z } from 'zod';
import type { Accessory, RegisterTools } from '../types.js';
import { accessoryFilterShape, isSecurityWrite, selectAccessories } from '../accessory-select.js';
import { checkCharacteristicValue } from './accessories.js';
import { errorMessage, errorResult, handle, jsonResult } from './helpers.js';

/** Default cap on how many accessories one call may change; `maxTargets` raises it up to {@link MAX_TARGETS}. */
export const DEFAULT_MAX_TARGETS = 25;
export const MAX_TARGETS = 200;

/** How many characteristic writes run at once. */
const CONCURRENCY = 4;

type Value = string | number | boolean;

interface Planned {
  uniqueId: string;
  serviceName: string;
  characteristicType: string;
  from: unknown;
  to: Value;
}

interface Skipped {
  uniqueId: string;
  serviceName?: string;
  reason: string;
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping the order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function plan(accessory: Accessory, characteristicType: string, value: Value): Planned | Skipped {
  const base = { uniqueId: accessory.uniqueId, serviceName: accessory.serviceName };
  if (isSecurityWrite(accessory, characteristicType)) {
    return { ...base, reason: 'a lock, garage door or security system: use set_security_accessory, which asks the user' };
  }
  const info = accessory.serviceCharacteristics?.find((c) => c.type.toLowerCase() === characteristicType.toLowerCase());
  if (!info) {
    return { ...base, reason: `no ${characteristicType} characteristic` };
  }
  const checked = checkCharacteristicValue(info, value);
  if ('error' in checked) {
    return { ...base, reason: checked.error };
  }
  return { ...base, characteristicType: info.type, from: info.value, to: checked.value };
}

export const register: RegisterTools = (tool, client) => {
  tool(
    'set_accessories',
    {
      title: 'Control several accessories',
      description:
        'Set one characteristic on many accessories at once, e.g. turn off every light in a room. Pick them by `uniqueIds` or by `filter` ' +
        '(the list_accessories filters: room, type, name, manufacturer, excludeManufacturer). Each value is checked per accessory; accessories ' +
        'without the characteristic or that reject the value are skipped and reported. Use dryRun=true to preview the targets first. ' +
        'Locks, garage doors and security systems (LockTargetState, TargetDoorState, SecuritySystemTargetState, or any lock / garage door / alarm accessory) ' +
        'are refused or skipped: change those with set_security_accessory, one at a time, which asks the user to confirm.',
      inputSchema: {
        uniqueIds: z.array(z.string().min(1)).min(1).max(MAX_TARGETS).optional().describe('The accessories to change (from list_accessories)'),
        filter: z.object(accessoryFilterShape).optional().describe('Pick the accessories like list_accessories does'),
        characteristicType: z.string().min(1).describe("The characteristic to set (e.g. 'On', 'Brightness', 'TargetTemperature')"),
        value: z.union([z.string(), z.number(), z.boolean()]).describe('The value to set on every target'),
        dryRun: z.boolean().optional().describe('Only list what would change (current → new value per accessory); set nothing.'),
        maxTargets: z
          .number()
          .int()
          .min(1)
          .max(MAX_TARGETS)
          .optional()
          .describe(`Refuse when more accessories than this would change (default ${DEFAULT_MAX_TARGETS}). Raise it only when the user meant that many.`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      scope: 'control',
    },
    handle('setting accessories', async ({ uniqueIds, filter, characteristicType, value, dryRun, maxTargets }) => {
      if (!uniqueIds === !filter) {
        return errorResult('Pass exactly one of `uniqueIds` or `filter`.');
      }
      if (isSecurityWrite(undefined, characteristicType)) {
        return errorResult(
          `${characteristicType} controls a lock, door or alarm and is not changed in bulk. ` +
            'Use set_security_accessory for each accessory (it asks the user to confirm).',
        );
      }

      let targets: Accessory[];
      const skipped: Skipped[] = [];
      if (filter) {
        const selected = await selectAccessories(client, filter);
        if ('error' in selected) {
          return errorResult(selected.error);
        }
        targets = selected.accessories;
      } else {
        const byId = new Map((await client.getAccessories()).map((a) => [a.uniqueId, a]));
        targets = [];
        for (const id of new Set(uniqueIds)) {
          const accessory = byId.get(id);
          if (accessory) {
            targets.push(accessory);
          } else {
            skipped.push({ uniqueId: id, reason: 'no such accessory' });
          }
        }
      }

      const planned: Planned[] = [];
      for (const accessory of targets) {
        const p = plan(accessory, characteristicType, value);
        if ('reason' in p) {
          skipped.push(p);
        } else {
          planned.push(p);
        }
      }

      const cap = maxTargets ?? DEFAULT_MAX_TARGETS;
      if (planned.length > cap) {
        return errorResult(
          `${planned.length} accessories would change, more than maxTargets (${cap}). ` +
            `Narrow the filter, or pass maxTargets=${planned.length} if that is intended.`,
        );
      }
      if (dryRun || planned.length === 0) {
        return jsonResult({ dryRun: Boolean(dryRun), wouldChange: planned.length, planned, skipped });
      }

      const results = await mapLimit(planned, CONCURRENCY, async (p) => {
        try {
          await client.setAccessoryCharacteristic(p.uniqueId, p.characteristicType, p.to);
          return { uniqueId: p.uniqueId, serviceName: p.serviceName, ok: true as const, value: p.to };
        } catch (error) {
          return { uniqueId: p.uniqueId, serviceName: p.serviceName, ok: false as const, error: errorMessage(error) };
        }
      });
      const failed = results.filter((r) => !r.ok).length;
      return jsonResult({ changed: results.length - failed, failed, results, skipped });
    }),
  );
};
