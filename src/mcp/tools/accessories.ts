import { z } from 'zod';
import type { Accessory, RegisterTools } from '../types.js';
import { READ, errorResult, handle, jsonResult } from './helpers.js';

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

export const register: RegisterTools = (tool, client) => {
  tool(
    'list_accessories',
    {
      title: 'List accessories',
      description: 'List all Homebridge accessories with their current state (on/off, brightness, temperature, etc.)',
      inputSchema: {
        room: z.string().optional().describe('Filter by room name (case-insensitive)'),
        type: z.string().optional().describe("Filter by accessory type (e.g. 'Lightbulb', 'Switch', 'Thermostat')"),
        manufacturer: z.string().optional().describe('Filter by manufacturer (case-insensitive, contains match)'),
        excludeManufacturer: z.string().optional().describe('Exclude accessories from this manufacturer (case-insensitive, contains match)'),
        name: z.string().optional().describe('Filter by service name (case-insensitive, contains match)'),
      },
      annotations: READ,
    },
    handle('listing accessories', async ({ room, type, manufacturer, excludeManufacturer, name }) => {
      const [all, layout] = await Promise.all([
        client.getAccessories(),
        room ? client.getAccessoryLayout() : undefined,
      ]);
      let accessories = all;

      // Room filter: resolve UIDs from layout
      if (room && layout) {
        const matchedRoom = layout.find((r) => r.name.toLowerCase() === room.toLowerCase());
        if (!matchedRoom) {
          return errorResult(`Room not found: "${room}". Available rooms: ${layout.map((r) => r.name).join(', ')}`);
        }
        const roomUids = new Set(matchedRoom.services.map((s) => s.uniqueId));
        accessories = accessories.filter((a) => roomUids.has(a.uniqueId));
      }

      if (type) {
        const t = type.toLowerCase();
        accessories = accessories.filter((a) => a.type?.toLowerCase() === t);
      }

      if (manufacturer) {
        const mfr = manufacturer.toLowerCase();
        accessories = accessories.filter((a) => a.accessoryInformation?.Manufacturer?.toLowerCase().includes(mfr));
      }

      if (excludeManufacturer) {
        const excl = excludeManufacturer.toLowerCase();
        accessories = accessories.filter((a) => !a.accessoryInformation?.Manufacturer?.toLowerCase().includes(excl));
      }

      if (name) {
        const n = name.toLowerCase();
        accessories = accessories.filter((a) => a.serviceName?.toLowerCase().includes(n));
      }

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
        'Use list_accessories first to find the uniqueId and available characteristicTypes.',
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
    handle('setting accessory', async ({ uniqueId, characteristicType, value }) =>
      jsonResult(await client.setAccessoryCharacteristic(uniqueId, characteristicType, value)),
    ),
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
