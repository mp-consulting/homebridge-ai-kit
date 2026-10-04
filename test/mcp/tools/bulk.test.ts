import { describe, expect, it, vi } from 'vitest';
import { register } from '../../../src/mcp/tools/bulk.js';
import type { Accessory } from '../../../src/mcp/types.js';
import { collectHandlers, mockClient } from '../helpers.js';

const light = (uniqueId: string, serviceName: string, on: boolean, extra: Partial<Accessory> = {}): Accessory => ({
  uniqueId,
  serviceName,
  type: 'Lightbulb',
  accessoryInformation: { Manufacturer: 'Hue' },
  serviceCharacteristics: [
    { type: 'On', value: on, format: 'bool', canWrite: true },
    { type: 'Brightness', value: 50, format: 'int', minValue: 0, maxValue: 100, canWrite: true },
  ],
  ...extra,
});

const accessories: Accessory[] = [
  light('l1', 'Kitchen Light', true),
  light('l2', 'Living Lamp', true),
  light('l3', 'Desk Lamp', false, { accessoryInformation: { Manufacturer: 'IKEA' } }),
  { uniqueId: 's1', serviceName: 'Sensor', type: 'TemperatureSensor', serviceCharacteristics: [{ type: 'CurrentTemperature', value: 20, canWrite: false }] },
];

function setup(overrides: Parameters<typeof mockClient>[0] = {}) {
  const client = mockClient({
    getAccessories: vi.fn().mockResolvedValue(accessories),
    getAccessoryLayout: vi.fn().mockResolvedValue([{ name: 'Living', services: [{ uniqueId: 'l2' }, { uniqueId: 'l3' }] }]),
    setAccessoryCharacteristic: vi.fn().mockResolvedValue({}),
    ...overrides,
  });
  return { client, run: collectHandlers(register, client).get('set_accessories')! };
}

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe('set_accessories', () => {
  it('previews a filter on dryRun without writing', async () => {
    const { client, run } = setup();
    const result = parse(await run({ filter: { room: 'living' }, characteristicType: 'on', value: 0, dryRun: true }));
    expect(client.setAccessoryCharacteristic).not.toHaveBeenCalled();
    expect(result).toEqual({
      dryRun: true,
      wouldChange: 2,
      planned: [
        { uniqueId: 'l2', serviceName: 'Living Lamp', characteristicType: 'On', from: true, to: false },
        { uniqueId: 'l3', serviceName: 'Desk Lamp', characteristicType: 'On', from: false, to: false },
      ],
      skipped: [],
    });
  });

  it('sets each target and reports a result per target', async () => {
    const set = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
    const { run } = setup({ setAccessoryCharacteristic: set });
    const result = parse(await run({ uniqueIds: ['l1', 'l2', 'l2', 'nope', 's1'], characteristicType: 'Brightness', value: '30' }));
    expect(set).toHaveBeenCalledWith('l1', 'Brightness', 30);
    expect(set).toHaveBeenCalledWith('l2', 'Brightness', 30);
    expect(result.changed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results).toEqual([
      { uniqueId: 'l1', serviceName: 'Kitchen Light', ok: true, value: 30 },
      { uniqueId: 'l2', serviceName: 'Living Lamp', ok: false, error: 'offline' },
    ]);
    expect(result.skipped).toEqual([
      { uniqueId: 'nope', reason: 'no such accessory' },
      { uniqueId: 's1', serviceName: 'Sensor', reason: 'no Brightness characteristic' },
    ]);
  });

  it('skips targets that reject the value', async () => {
    const { client, run } = setup();
    const result = parse(await run({ filter: { type: 'lightbulb', excludeManufacturer: 'ikea' }, characteristicType: 'Brightness', value: 150 }));
    expect(client.setAccessoryCharacteristic).not.toHaveBeenCalled();
    expect(result.wouldChange).toBe(0);
    expect(result.skipped[0].reason).toContain('within range');
  });

  it('refuses security characteristics', async () => {
    const { client, run } = setup();
    const result = await run({ uniqueIds: ['l1'], characteristicType: 'LockTargetState', value: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('set_accessory');
    expect(client.getAccessories).not.toHaveBeenCalled();
  });

  it('needs exactly one way to pick targets', async () => {
    const { run } = setup();
    expect((await run({ characteristicType: 'On', value: true })).isError).toBe(true);
    expect((await run({ uniqueIds: ['l1'], filter: {}, characteristicType: 'On', value: true })).isError).toBe(true);
  });

  it('reports an unknown room', async () => {
    const { run } = setup();
    const result = await run({ filter: { room: 'Attic' }, characteristicType: 'On', value: true });
    expect(result.content[0].text).toContain('Room not found: "Attic"');
  });

  it('caps how many accessories change unless maxTargets is raised', async () => {
    const many = Array.from({ length: 30 }, (_, i) => light(`x${i}`, `L${i}`, true));
    const { client, run } = setup({ getAccessories: vi.fn().mockResolvedValue(many) });
    const refused = await run({ filter: { type: 'Lightbulb' }, characteristicType: 'On', value: false });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('maxTargets=30');
    const done = parse(await run({ filter: { type: 'Lightbulb' }, characteristicType: 'On', value: false, maxTargets: 30 }));
    expect(done.changed).toBe(30);
    expect(client.setAccessoryCharacteristic).toHaveBeenCalledTimes(30);
  });
});
