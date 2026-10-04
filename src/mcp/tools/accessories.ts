import { z } from 'zod';
import type { Accessory, CharacteristicInfo, RegisterTools } from '../types.js';
import { READ, errorResult, handle, jsonResult } from './helpers.js';
import { accessoryFilterShape, selectAccessories } from '../accessory-select.js';

function compactAccessory(acc: Accessory) {
  return {
    uniqueId: acc.uniqueId,
    serviceName: acc.serviceName,
    type: acc.type,
    manufacturer: acc.accessoryInformation?.Manufacturer ?? null,
    model: acc.accessoryInformation?.Model ?? null,
    values: acc.values ?? {},
  };
}

const INTEGER_FORMATS = new Set(['int', 'uint8', 'uint16', 'uint32', 'uint64']);

type Value = string | number | boolean;

/**
 * Check `value` against a characteristic's metadata (format, range, step,
 * valid values, write permission) and coerce it to the expected type,
 * e.g. "50" → 50 or 1 → true. Returns an error message when it cannot be set.
 */
export function checkCharacteristicValue(info: CharacteristicInfo, value: Value): { value: Value } | { error: string } {
  const name = info.type;
  if (info.canWrite === false) {
    return { error: `${name} is read-only.` };
  }
  const format = info.format?.toLowerCase();
  if (format === 'bool') {
    if (typeof value === 'boolean') {
      return { value };
    }
    if (value === 1 || value === 0 || value === '1' || value === '0' || value === 'true' || value === 'false') {
      return { value: value === 1 || value === '1' || value === 'true' };
    }
    return { error: `${name} expects true or false, got ${JSON.stringify(value)}.` };
  }
  if (format === 'string' || format === 'data' || format === 'tlv8') {
    const s = String(value);
    if (info.maxLen !== undefined && s.length > info.maxLen) {
      return { error: `${name} accepts at most ${info.maxLen} characters.` };
    }
    return { value: s };
  }
  if (format === 'float' || (format && INTEGER_FORMATS.has(format))) {
    const n = Number(value);
    if ((typeof value === 'string' && value.trim() === '') || !Number.isFinite(n)) {
      return { error: `${name} expects a number, got ${JSON.stringify(value)}.` };
    }
    if (format !== 'float' && !Number.isInteger(n)) {
      return { error: `${name} expects a whole number, got ${n}.` };
    }
    const range = [info.minValue !== undefined ? `min ${info.minValue}` : '', info.maxValue !== undefined ? `max ${info.maxValue}` : '']
      .filter(Boolean)
      .join(', ');
    if ((info.minValue !== undefined && n < info.minValue) || (info.maxValue !== undefined && n > info.maxValue)) {
      return { error: `${name} must be within range (${range}), got ${n}.` };
    }
    if (info.validValues?.length && !info.validValues.includes(n)) {
      return { error: `${name} must be one of ${info.validValues.join(', ')}, got ${n}.` };
    }
    if (info.minStep) {
      const base = info.minValue ?? 0;
      const steps = (n - base) / info.minStep;
      if (Math.abs(steps - Math.round(steps)) > 1e-6) {
        const nearest = base + Math.round(steps) * info.minStep;
        return { error: `${name} moves in steps of ${info.minStep}; try ${Number(nearest.toFixed(6))}.` };
      }
    }
    return { value: n };
  }
  return { value };
}

export const register: RegisterTools = (tool, client) => {
  tool(
    'list_accessories',
    {
      title: 'List accessories',
      description: 'List all Homebridge accessories with their current state (on/off, brightness, temperature, etc.)',
      inputSchema: accessoryFilterShape,
      annotations: READ,
    },
    handle('listing accessories', async (filter) => {
      const selected = await selectAccessories(client, filter);
      if ('error' in selected) {
        return errorResult(selected.error);
      }
      const { accessories } = selected;
      return jsonResult(accessories.map(compactAccessory));
    }),
  );

  tool(
    'get_accessory',
    {
      title: 'Get accessory',
      description: 'Get detailed information about a specific accessory by its uniqueId. Use list_accessories first to find the uniqueId.',
      inputSchema: { uniqueId: z.string().min(1).describe('The unique identifier of the accessory') },
      annotations: READ,
    },
    handle('getting accessory', async ({ uniqueId }) => jsonResult(await client.getAccessory(uniqueId))),
  );

  tool(
    'set_accessory',
    {
      title: 'Control accessory',
      description:
        'Control a Homebridge accessory — turn it on/off, set brightness, color temperature, etc. ' +
        'Use list_accessories first to find the uniqueId and available characteristicTypes. ' +
        'The value is checked against the characteristic (format, min/max, step, valid values, writable) before it is sent.',
      inputSchema: {
        uniqueId: z.string().min(1).describe('The unique identifier of the accessory'),
        characteristicType: z
          .string()
          .min(1)
          .describe(
            "The characteristic to set (e.g. 'On', 'Brightness', 'ColorTemperature', 'Hue', 'Saturation', 'TargetTemperature', 'TargetDoorState')",
          ),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .describe('The value to set (e.g. true/false for On, 0-100 for Brightness)'),
      },
      // Changes physical device state (locks, garage doors) but doesn't destroy data.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handle('setting accessory', async ({ uniqueId, characteristicType, value }) => {
      const accessory = await client.getAccessory(uniqueId);
      const characteristics = accessory?.serviceCharacteristics;
      let toSend: Value = value;
      if (characteristics?.length) {
        const info = characteristics.find((c) => c.type.toLowerCase() === characteristicType.toLowerCase());
        if (!info) {
          const writable = characteristics.filter((c) => c.canWrite !== false).map((c) => c.type);
          return errorResult(`${accessory.serviceName ?? uniqueId} has no characteristic "${characteristicType}". Writable: ${writable.join(', ') || 'none'}.`);
        }
        const checked = checkCharacteristicValue(info, value);
        if ('error' in checked) {
          return errorResult(checked.error);
        }
        toSend = checked.value;
        characteristicType = info.type;
      }
      return jsonResult(await client.setAccessoryCharacteristic(uniqueId, characteristicType, toSend));
    }),
  );

  tool(
    'get_accessory_layout',
    {
      title: 'Get room layout',
      description: 'Get the accessories room layout as configured in the Homebridge UI.',
      annotations: READ,
    },
    handle('getting layout', async () => {
      const [layout, accessories] = await Promise.all([client.getAccessoryLayout(), client.getAccessories()]);
      const accessoryMap = new Map(accessories.map((acc) => [acc.uniqueId, acc]));

      const enriched = layout.map((room) => ({
        name: room.name,
        services: room.services.map((svc) => {
          const acc = accessoryMap.get(svc.uniqueId);
          return {
            uniqueId: svc.uniqueId,
            serviceName: acc?.serviceName ?? svc.customName ?? 'Unknown',
            type: acc?.type ?? 'Unknown',
            manufacturer: acc?.accessoryInformation?.Manufacturer ?? null,
          };
        }),
      }));

      return jsonResult(enriched);
    }),
  );
};
