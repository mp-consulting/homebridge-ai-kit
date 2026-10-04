import { describe, expect, it, vi } from 'vitest';
import { register } from '../../../src/mcp/tools/scenes.js';
import { HomebridgeApiError } from '../../../src/mcp/homebridge-client.js';
import type { Accessory, Scene } from '../../../src/mcp/types.js';
import { collectHandlers, mockClient } from '../helpers.js';

const scenes: Scene[] = [
  { id: 'a1b2c3d4e5f60718', name: 'Movie', actions: [{ uniqueId: 'l1', characteristicType: 'On', value: false }], schedules: [] },
  { id: 'ffffffffffffffff', name: 'Leave', actions: [{ uniqueId: 'lock', characteristicType: 'LockTargetState', value: 0 }], schedules: [] },
];

const accessories: Accessory[] = [
  {
    uniqueId: 'l1',
    serviceName: 'Lamp',
    type: 'Lightbulb',
    serviceCharacteristics: [
      { type: 'On', value: true, format: 'bool', canWrite: true },
      { type: 'Brightness', value: 40, format: 'int', canWrite: true },
      { type: 'Identify', value: null, format: 'bool', canWrite: true },
      { type: 'Name', value: 'Lamp', format: 'string', canWrite: true },
      { type: 'StatusFault', value: 0, format: 'uint8', canWrite: false },
    ],
  },
  { uniqueId: 'lock', serviceName: 'Door', type: 'LockMechanism', serviceCharacteristics: [{ type: 'LockTargetState', value: 1, format: 'uint8', canWrite: true }] },
  { uniqueId: 'cam', serviceName: 'Cam', type: 'CameraRTPStreamManagement', serviceCharacteristics: [{ type: 'SetupEndpoints', value: 'AAA', format: 'tlv8', canWrite: true }] },
];

const missing = new HomebridgeApiError(404, 'GET', '/api/scenes', '{"message":"Cannot GET /api/scenes","statusCode":404}');

function setup(overrides: Parameters<typeof mockClient>[0] = {}) {
  const client = mockClient({
    listScenes: vi.fn().mockResolvedValue(scenes),
    runScene: vi.fn().mockResolvedValue({ sceneId: 'a1b2c3d4e5f60718', ok: true, results: [] }),
    createScene: vi.fn().mockImplementation(async (s: object) => ({ id: 'new', ...s })),
    getAccessories: vi.fn().mockResolvedValue(accessories),
    ...overrides,
  });
  return { client, tools: collectHandlers(register, client) };
}

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe('scene tools', () => {
  it('lists scenes', async () => {
    const { tools } = setup();
    expect(parse(await tools.get('list_scenes')!())).toEqual(scenes);
  });

  it('says scenes need Glass UI', async () => {
    const { tools } = setup({ listScenes: vi.fn().mockRejectedValue(missing) });
    expect((await tools.get('list_scenes')!()).content[0].text).toBe(
      'Error listing scenes: Scenes requires Homebridge Glass UI (this Homebridge UI has no GET /api/scenes).',
    );
  });

  it('runs a scene by name', async () => {
    const { client, tools } = setup();
    const result = parse(await tools.get('run_scene')!({ scene: 'movie' }));
    expect(client.runScene).toHaveBeenCalledWith('a1b2c3d4e5f60718');
    expect(result).toEqual({ name: 'Movie', sceneId: 'a1b2c3d4e5f60718', ok: true, results: [] });
  });

  it('reports an unknown scene', async () => {
    const { tools } = setup();
    expect((await tools.get('run_scene')!({ scene: 'Party' })).content[0].text).toContain('No scene "Party". Scenes: Movie, Leave.');
    const empty = setup({ listScenes: vi.fn().mockResolvedValue([]) });
    expect((await empty.tools.get('run_scene')!({ scene: 'Party' })).content[0].text).toContain('Scenes: none.');
  });

  it('refuses a scene that unlocks something, even with a confirm flag, and points to set_security_accessory', async () => {
    const { client, tools } = setup();
    for (const args of [{ scene: 'ffffffffffffffff' }, { scene: 'Leave', confirm: true }]) {
      const refused = await tools.get('run_scene')!(args);
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('set_security_accessory');
    }
    expect(client.runScene).not.toHaveBeenCalled();
  });

  it('treats any characteristic of a lock accessory in a scene as security-sensitive', async () => {
    const { client, tools } = setup({
      listScenes: vi.fn().mockResolvedValue([{ id: 's1', name: 'Odd', actions: [{ uniqueId: 'lock', characteristicType: 'LockManagementAutoSecurityTimeout', value: 0 }], schedules: [] }]),
    });
    expect((await tools.get('run_scene')!({ scene: 'Odd' })).isError).toBe(true);
    expect(client.runScene).not.toHaveBeenCalled();
  });

  it('saves the current writable state, without security, triggers or blobs', async () => {
    const { client, tools } = setup();
    const result = parse(await tools.get('save_scene')!({ name: 'Evening', uniqueIds: ['l1', 'lock', 'cam', 'gone'] }));
    const actions = [
      { uniqueId: 'l1', characteristicType: 'On', value: true },
      { uniqueId: 'l1', characteristicType: 'Brightness', value: 40 },
    ];
    expect(client.createScene).toHaveBeenCalledWith({ name: 'Evening', actions, schedules: [] });
    expect(result.created.id).toBe('new');
    expect(result.skipped).toEqual([
      { uniqueId: 'lock', reason: 'nothing to capture' },
      { uniqueId: 'cam', reason: 'nothing to capture' },
      { uniqueId: 'gone', reason: 'no such accessory' },
    ]);
  });

  it('previews only the chosen characteristics on dryRun', async () => {
    const { client, tools } = setup();
    const result = parse(await tools.get('save_scene')!({ name: 'Off', uniqueIds: ['l1'], characteristics: ['on'], dryRun: true }));
    expect(result).toEqual({ dryRun: true, name: 'Off', actions: [{ uniqueId: 'l1', characteristicType: 'On', value: true }], skipped: [] });
    expect(client.createScene).not.toHaveBeenCalled();
  });

  it('refuses an empty or oversized scene', async () => {
    const { tools } = setup();
    expect((await tools.get('save_scene')!({ name: 'X', uniqueIds: ['lock'] })).content[0].text).toContain('Nothing to save: lock (nothing to capture)');
    const many: Accessory[] = Array.from({ length: 30 }, (_, i) => ({
      uniqueId: `a${i}`,
      serviceName: `A${i}`,
      type: 'Lightbulb',
      serviceCharacteristics: [
        { type: 'On', value: true, format: 'bool' },
        { type: 'Brightness', value: 1, format: 'int' },
      ],
    }));
    const big = setup({ getAccessories: vi.fn().mockResolvedValue(many) });
    const result = await big.tools.get('save_scene')!({ name: 'Big', uniqueIds: many.map((a) => a.uniqueId) });
    expect(result.content[0].text).toContain('60 actions');
  });

  it('says saving needs Glass UI', async () => {
    const { tools } = setup({ createScene: vi.fn().mockRejectedValue(new HomebridgeApiError(404, 'POST', '/api/scenes', 'Cannot POST /api/scenes')) });
    expect((await tools.get('save_scene')!({ name: 'E', uniqueIds: ['l1'] })).content[0].text).toContain('Saving a scene requires Homebridge Glass UI');
  });
});
