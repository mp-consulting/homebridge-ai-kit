import { describe, expect, it, vi } from 'vitest';
import { checkCharacteristicValue, isSecurityWrite, register } from '../../../src/mcp/tools/accessories.js';
import type { CharacteristicInfo } from '../../../src/mcp/types.js';
import { collectHandlers, collectTools, mockClient } from '../helpers.js';

const c = (info: Partial<CharacteristicInfo>): CharacteristicInfo => ({ type: 'X', value: null, ...info });

describe('checkCharacteristicValue', () => {
  it('coerces booleans', () => {
    expect(checkCharacteristicValue(c({ format: 'bool' }), true)).toEqual({ value: true });
    expect(checkCharacteristicValue(c({ format: 'bool' }), 1)).toEqual({ value: true });
    expect(checkCharacteristicValue(c({ format: 'bool' }), 'false')).toEqual({ value: false });
    expect(checkCharacteristicValue(c({ format: 'bool' }), 'on')).toEqual({ error: 'X expects true or false, got "on".' });
  });

  it('checks numbers against range, step and valid values', () => {
    const brightness = c({ type: 'Brightness', format: 'int', minValue: 0, maxValue: 100, minStep: 1 });
    expect(checkCharacteristicValue(brightness, '50')).toEqual({ value: 50 });
    expect(checkCharacteristicValue(brightness, 150)).toEqual({ error: 'Brightness must be within range (min 0, max 100), got 150.' });
    expect(checkCharacteristicValue(brightness, 5.5)).toEqual({ error: 'Brightness expects a whole number, got 5.5.' });
    expect(checkCharacteristicValue(brightness, 'abc')).toEqual({ error: 'Brightness expects a number, got "abc".' });
    expect(checkCharacteristicValue(brightness, ' ')).toMatchObject({ error: expect.stringContaining('expects a number') });
    const temp = c({ type: 'TargetTemperature', format: 'float', minValue: 10, maxValue: 38, minStep: 0.5 });
    expect(checkCharacteristicValue(temp, 21.5)).toEqual({ value: 21.5 });
    expect(checkCharacteristicValue(temp, 21.3)).toEqual({ error: 'TargetTemperature moves in steps of 0.5; try 21.5.' });
    expect(checkCharacteristicValue(c({ format: 'float', minStep: 0.1 }), 0.3)).toEqual({ value: 0.3 });
    expect(checkCharacteristicValue(c({ format: 'float', maxValue: 1 }), 2)).toEqual({ error: 'X must be within range (max 1), got 2.' });
    const door = c({ type: 'TargetDoorState', format: 'uint8', validValues: [0, 1] });
    expect(checkCharacteristicValue(door, 2)).toEqual({ error: 'TargetDoorState must be one of 0, 1, got 2.' });
    expect(checkCharacteristicValue(door, true)).toEqual({ value: 1 });
  });

  it('checks strings, write access and passes unknown formats through', () => {
    expect(checkCharacteristicValue(c({ format: 'string', maxLen: 3 }), 'abcd')).toEqual({ error: 'X accepts at most 3 characters.' });
    expect(checkCharacteristicValue(c({ format: 'string' }), 5)).toEqual({ value: '5' });
    expect(checkCharacteristicValue(c({ canWrite: false }), 1)).toEqual({ error: 'X is read-only.' });
    expect(checkCharacteristicValue(c({}), 'anything')).toEqual({ value: 'anything' });
  });
});

describe('set_accessory validation', () => {
  const accessory = {
    uniqueId: 'lamp',
    serviceName: 'Lamp',
    type: 'Lightbulb',
    serviceCharacteristics: [
      { type: 'On', value: false, format: 'bool', canWrite: true },
      { type: 'Brightness', value: 10, format: 'int', minValue: 0, maxValue: 100, canWrite: true },
      { type: 'Name', value: 'Lamp', format: 'string', canWrite: false },
    ],
  };

  function setup() {
    const client = mockClient({ getAccessory: vi.fn().mockResolvedValue(accessory), setAccessoryCharacteristic: vi.fn().mockResolvedValue({ ok: 1 }) });
    return { client, set: collectHandlers(register, client).get('set_accessory')! };
  }

  it('sends the coerced value with the canonical characteristic name', async () => {
    const { client, set } = setup();
    await set({ uniqueId: 'lamp', characteristicType: 'brightness', value: '40' });
    expect(client.setAccessoryCharacteristic).toHaveBeenCalledWith('lamp', 'Brightness', 40);
  });

  it('rejects unknown characteristics and invalid values before calling Homebridge', async () => {
    const { client, set } = setup();
    const unknown = await set({ uniqueId: 'lamp', characteristicType: 'Hue', value: 1 });
    expect(unknown.content[0].text).toBe('Lamp has no characteristic "Hue". Writable: On, Brightness.');
    const bad = await set({ uniqueId: 'lamp', characteristicType: 'Brightness', value: 101 });
    expect(bad.isError).toBe(true);
    expect(client.setAccessoryCharacteristic).not.toHaveBeenCalled();
  });

  it('lists none when nothing is writable', async () => {
    const client = mockClient({
      getAccessory: vi.fn().mockResolvedValue({ uniqueId: 's', serviceCharacteristics: [{ type: 'CurrentTemperature', value: 20, canWrite: false }] }),
    });
    const result = await collectHandlers(register, client).get('set_accessory')!({ uniqueId: 's', characteristicType: 'On', value: true });
    expect(result.content[0].text).toBe('s has no characteristic "On". Writable: none.');
  });
});

describe('security-sensitive writes', () => {
  const lock = {
    uniqueId: 'door',
    serviceName: 'Front Door',
    type: 'LockMechanism',
    serviceCharacteristics: [{ type: 'LockTargetState', value: 1, format: 'uint8', validValues: [0, 1], canWrite: true }],
  };

  it('classifies locks, garage doors and alarms', () => {
    expect(isSecurityWrite({ type: 'Lightbulb' }, 'On')).toBe(false);
    expect(isSecurityWrite(undefined, 'Brightness')).toBe(false);
    expect(isSecurityWrite({ type: 'Lightbulb' }, 'LockTargetState')).toBe(true);
    expect(isSecurityWrite(undefined, 'target_door_state')).toBe(true);
    expect(isSecurityWrite({ type: 'Security System' }, 'Name')).toBe(true);
    expect(isSecurityWrite({ type: 'GarageDoorOpener' }, 'ObstructionDetected')).toBe(true);
  });

  it('set_accessory refuses them and points to set_security_accessory', async () => {
    const client = mockClient({ getAccessory: vi.fn().mockResolvedValue(lock), setAccessoryCharacteristic: vi.fn() });
    const result = await collectHandlers(register, client).get('set_accessory')!({ uniqueId: 'door', characteristicType: 'LockTargetState', value: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Use set_security_accessory');
    expect(client.setAccessoryCharacteristic).not.toHaveBeenCalled();
  });

  it('set_security_accessory writes them, validated, and is destructive', async () => {
    const client = mockClient({ getAccessory: vi.fn().mockResolvedValue(lock), setAccessoryCharacteristic: vi.fn().mockResolvedValue({ ok: 1 }) });
    const tools = collectTools(register, client);
    const secure = tools.get('set_security_accessory')!;
    expect(secure.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.get('set_accessory')!.config.annotations.destructiveHint).toBe(false);
    expect((await secure.handler({ uniqueId: 'door', characteristicType: 'locktargetstate', value: 2 })).isError).toBe(true);
    await secure.handler({ uniqueId: 'door', characteristicType: 'locktargetstate', value: 0 });
    expect(client.setAccessoryCharacteristic).toHaveBeenCalledWith('door', 'LockTargetState', 0);
  });
});
