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
 * Characteristics that lock/unlock, open/close or arm/disarm something. Only
 * `set_security_accessory` writes them: it is marked destructive, so clients
 * (and `runAgent`) ask the user first. `set_accessory`, `set_accessories`,
 * `run_scene` and `save_scene` refuse or skip them.
 */
export const SECURITY_CHARACTERISTICS: ReadonlySet<string> = new Set(
  ['LockTargetState', 'LockCurrentState', 'LockControlPoint', 'TargetDoorState', 'CurrentDoorState', 'SecuritySystemTargetState', 'SecuritySystemCurrentState'].map((c) =>
    c.toLowerCase(),
  ),
);

/** Services whose every writable characteristic counts as security-sensitive. */
export const SECURITY_SERVICES: ReadonlySet<string> = new Set(['LockMechanism', 'LockManagement', 'GarageDoorOpener', 'SecuritySystem'].map((s) => s.toLowerCase()));

const normalize = (name: string) => name.replace(/[\s_-]/g, '').toLowerCase();

/** True when writing `characteristicType` on `accessory` could unlock, open or disarm something. */
export function isSecurityWrite(accessory: Pick<Accessory, 'type'> | undefined, characteristicType: string): boolean {
  return SECURITY_CHARACTERISTICS.has(normalize(characteristicType)) || (accessory?.type !== undefined && SECURITY_SERVICES.has(normalize(accessory.type)));
}
