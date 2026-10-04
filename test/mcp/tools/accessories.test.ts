import { describe, it, expect, vi } from 'vitest';
import { register } from '../../../src/mcp/tools/accessories.js';
import { collectHandlers, mockClient } from '../helpers.js';

// ── Helpers ────────────────────────────────────────────────────

function makeAccessory(overrides: Record<string, unknown> = {}) {
  return {
    uniqueId: 'acc-1',
    serviceName: 'Living Room Light',
    type: 'Lightbulb',
    accessoryInformation: { Manufacturer: 'Philips', Model: 'Hue', Name: 'Light' },
    serviceCharacteristics: [{ type: 'On', value: true }],
    values: { On: true, Brightness: 75 },
    ...overrides,
  };
}

function makeRoom(name: string, uniqueIds: string[]) {
  return {
    name,
    services: uniqueIds.map((id) => ({ uniqueId: id })),
  };
}

function handlersFor(overrides: Parameters<typeof mockClient>[0] = {}) {
  const client = mockClient({
    getAccessories: vi.fn().mockResolvedValue([]),
    getAccessoryLayout: vi.fn().mockResolvedValue([]),
    setAccessoryCharacteristic: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  });
  return { client, handlers: collectHandlers(register, client) };
}

// ── Tests ──────────────────────────────────────────────────────

describe('accessories tools', () => {
  describe('list_accessories', () => {
    it('returns compact accessories', async () => {
      const { handlers } = handlersFor({ getAccessories: vi.fn().mockResolvedValue([makeAccessory()]) });
      const result = await handlers.get('list_accessories')!({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed).toEqual([
        {
          uniqueId: 'acc-1',
          serviceName: 'Living Room Light',
          type: 'Lightbulb',
          manufacturer: 'Philips',
          model: 'Hue',
          values: { On: true, Brightness: 75 },
        },
      ]);
    });

    it('emits compact JSON', async () => {
      const { handlers } = handlersFor({ getAccessories: vi.fn().mockResolvedValue([makeAccessory()]) });
      const result = await handlers.get('list_accessories')!({});

      expect(result.content[0].text).not.toContain('\n');
    });

    it('does not fetch the layout without a room filter', async () => {
      const { client, handlers } = handlersFor();
      await handlers.get('list_accessories')!({});

      expect(client.getAccessoryLayout).not.toHaveBeenCalled();
    });

    it('filters by type (case-insensitive)', async () => {
      const light = makeAccessory({ uniqueId: 'l1', type: 'Lightbulb' });
      const sw = makeAccessory({ uniqueId: 's1', type: 'Switch', serviceName: 'Fan' });
      const { handlers } = handlersFor({ getAccessories: vi.fn().mockResolvedValue([light, sw]) });
      const result = await handlers.get('list_accessories')!({ type: 'switch' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].uniqueId).toBe('s1');
    });

    it('filters by manufacturer (case-insensitive, contains)', async () => {
      const philips = makeAccessory({ uniqueId: 'p1' });
      const ikea = makeAccessory({ uniqueId: 'i1', accessoryInformation: { Manufacturer: 'IKEA' } });
      const { handlers } = handlersFor({ getAccessories: vi.fn().mockResolvedValue([philips, ikea]) });
      const result = await handlers.get('list_accessories')!({ manufacturer: 'phil' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].uniqueId).toBe('p1');
    });

    it('filters by excludeManufacturer', async () => {
      const philips = makeAccessory({ uniqueId: 'p1' });
      const ikea = makeAccessory({ uniqueId: 'i1', accessoryInformation: { Manufacturer: 'IKEA' } });
      const { handlers } = handlersFor({ getAccessories: vi.fn().mockResolvedValue([philips, ikea]) });
      const result = await handlers.get('list_accessories')!({ excludeManufacturer: 'philips' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].uniqueId).toBe('i1');
    });

    it('filters by name (case-insensitive, contains)', async () => {
      const light = makeAccessory({ uniqueId: 'l1', serviceName: 'Living Room Light' });
      const fan = makeAccessory({ uniqueId: 'f1', serviceName: 'Kitchen Fan' });
      const { handlers } = handlersFor({ getAccessories: vi.fn().mockResolvedValue([light, fan]) });
      const result = await handlers.get('list_accessories')!({ name: 'kitchen' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].uniqueId).toBe('f1');
    });

    it('filters by room, fetching accessories and layout in parallel', async () => {
      const a1 = makeAccessory({ uniqueId: 'a1' });
      const a2 = makeAccessory({ uniqueId: 'a2', serviceName: 'Bedroom Light' });
      const rooms = [makeRoom('Living Room', ['a1']), makeRoom('Bedroom', ['a2'])];
      let resolveAccessories!: (v: unknown) => void;
      const { client, handlers } = handlersFor({
        getAccessories: vi.fn(() => new Promise((r) => (resolveAccessories = r))),
        getAccessoryLayout: vi.fn().mockResolvedValue(rooms),
      });

      const pending = handlers.get('list_accessories')!({ room: 'Bedroom' });
      // The layout request starts before the accessories request has resolved.
      expect(client.getAccessoryLayout).toHaveBeenCalled();
      resolveAccessories([a1, a2]);
      const parsed = JSON.parse((await pending).content[0].text);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].uniqueId).toBe('a2');
    });

    it('returns error when room not found', async () => {
      const { handlers } = handlersFor({
        getAccessoryLayout: vi.fn().mockResolvedValue([makeRoom('Living Room', ['a1'])]),
      });
      const result = await handlers.get('list_accessories')!({ room: 'Garage' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Room not found');
      expect(result.content[0].text).toContain('Living Room');
    });

    it('handles API errors gracefully', async () => {
      const { handlers } = handlersFor({ getAccessories: vi.fn().mockRejectedValue(new Error('Network error')) });
      const result = await handlers.get('list_accessories')!({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error listing accessories: Network error');
    });

    it('handles missing accessoryInformation gracefully', async () => {
      const acc = makeAccessory({ accessoryInformation: {}, values: undefined });
      const { handlers } = handlersFor({ getAccessories: vi.fn().mockResolvedValue([acc]) });
      const result = await handlers.get('list_accessories')!({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed[0].manufacturer).toBeNull();
      expect(parsed[0].model).toBeNull();
      expect(parsed[0].values).toEqual({});
    });
  });

  describe('get_accessory', () => {
    it('fetches the single accessory instead of the whole list', async () => {
      const { client, handlers } = handlersFor({
        getAccessory: vi.fn().mockResolvedValue(makeAccessory({ uniqueId: 'abc' })),
      });
      const result = await handlers.get('get_accessory')!({ uniqueId: 'abc' });

      expect(JSON.parse(result.content[0].text).uniqueId).toBe('abc');
      expect(result.isError).toBeUndefined();
      expect(client.getAccessory).toHaveBeenCalledWith('abc');
      expect(client.getAccessories).not.toHaveBeenCalled();
    });

    it('returns error when accessory not found', async () => {
      const { handlers } = handlersFor({
        getAccessory: vi.fn().mockRejectedValue(new Error('Homebridge API error 404 GET /api/accessories/missing: Not Found')),
      });
      const result = await handlers.get('get_accessory')!({ uniqueId: 'missing' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('404');
    });
  });

  describe('set_accessory', () => {
    it('calls setAccessoryCharacteristic and returns result', async () => {
      const { client, handlers } = handlersFor();
      const result = await handlers.get('set_accessory')!({
        uniqueId: 'acc-1',
        characteristicType: 'Brightness',
        value: 50,
      });

      expect(client.setAccessoryCharacteristic).toHaveBeenCalledWith('acc-1', 'Brightness', 50);
      expect(result.isError).toBeUndefined();
    });

    it('handles errors', async () => {
      const { handlers } = handlersFor({ setAccessoryCharacteristic: vi.fn().mockRejectedValue(new Error('fail')) });
      const result = await handlers.get('set_accessory')!({ uniqueId: 'x', characteristicType: 'On', value: true });

      expect(result.isError).toBe(true);
    });
  });

  describe('get_accessory_layout', () => {
    it('returns enriched layout with accessory details', async () => {
      const { handlers } = handlersFor({
        getAccessories: vi.fn().mockResolvedValue([makeAccessory({ uniqueId: 'a1', serviceName: 'Lamp', type: 'Lightbulb' })]),
        getAccessoryLayout: vi.fn().mockResolvedValue([{ name: 'Living Room', services: [{ uniqueId: 'a1' }] }]),
      });
      const result = await handlers.get('get_accessory_layout')!({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed[0].name).toBe('Living Room');
      expect(parsed[0].services[0].serviceName).toBe('Lamp');
      expect(parsed[0].services[0].type).toBe('Lightbulb');
    });

    it('falls back to customName when accessory not in map', async () => {
      const { handlers } = handlersFor({
        getAccessoryLayout: vi.fn().mockResolvedValue([{ name: 'Room', services: [{ uniqueId: 'unknown', customName: 'Custom' }] }]),
      });
      const result = await handlers.get('get_accessory_layout')!({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed[0].services[0].serviceName).toBe('Custom');
      expect(parsed[0].services[0].type).toBe('Unknown');
    });

    it('handles errors', async () => {
      const { handlers } = handlersFor({ getAccessoryLayout: vi.fn().mockRejectedValue(new Error('down')) });
      const result = await handlers.get('get_accessory_layout')!({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error getting layout: down');
    });
  });
});
