import { z } from 'zod';
import type { HomebridgeClient } from './homebridge-client.js';
import type { Accessory } from './types.js';

/** The `list_accessories` filters, shared by tools that pick accessories the same way. */
export const accessoryFilterShape = {
  room: z.string().optional().describe('Filter by room name (case-insensitive)'),
  type: z.string().optional().describe("Filter by accessory type (e.g. 'Lightbulb', 'Switch', 'Thermostat')"),
  manufacturer: z.string().optional().describe('Filter by manufacturer (case-insensitive, contains match)'),
  excludeManufacturer: z.string().optional().describe('Exclude accessories from this manufacturer (case-insensitive, contains match)'),
  name: z.string().optional().describe('Filter by service name (case-insensitive, contains match)'),
};

export interface AccessoryFilter {
  room?: string;
  type?: string;
  manufacturer?: string;
  excludeManufacturer?: string;
  name?: string;
}

/**
 * Fetches the accessories and applies `filter`. Rooms come from the Homebridge UI
 * layout (`/api/accessories/layout`), not HomeKit. Returns an error message for an unknown room.
 */
export async function selectAccessories(
  client: HomebridgeClient,
  { room, type, manufacturer, excludeManufacturer, name }: AccessoryFilter,
): Promise<{ accessories: Accessory[] } | { error: string }> {
  const [all, layout] = await Promise.all([client.getAccessories(), room ? client.getAccessoryLayout() : undefined]);
  let accessories = all;

  if (room && layout) {
    const matchedRoom = layout.find((r) => r.name.toLowerCase() === room.toLowerCase());
    if (!matchedRoom) {
      return { error: `Room not found: "${room}". Available rooms: ${layout.map((r) => r.name).join(', ')}` };
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
  return { accessories };
}

/**
 * Characteristics that open, unlock or disarm something. Bulk and scene tools
 * refuse them so each such change goes through `set_accessory`, one accessory at a time.
 */
const SECURITY_CHARACTERISTICS = new Set(['locktargetstate', 'targetdoorstate', 'securitysystemtargetstate']);

export function isSecurityCharacteristic(type: string): boolean {
  return SECURITY_CHARACTERISTICS.has(type.toLowerCase());
}
