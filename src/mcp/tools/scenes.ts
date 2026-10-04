import { z } from 'zod';
import type { HomebridgeClient } from '../homebridge-client.js';
import { requireGlassUi } from '../homebridge-client.js';
import type { RegisterTools, Scene } from '../types.js';
import { isSecurityCharacteristic } from '../accessory-select.js';
import { READ, errorResult, handle, jsonResult, structuredResult } from './helpers.js';
import { SCENE_LIST } from './output-schemas.js';

/** Glass UI's limit on actions per scene. */
export const MAX_SCENE_ACTIONS = 50;

/** Writable characteristics that are not part of a "look": they trigger something or rename the accessory. */
const NOT_STATE = new Set(['identify', 'name', 'configuredname']);

type SceneValue = string | number | boolean;

function isSceneValue(v: unknown): v is SceneValue {
  return typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 256);
}

const listScenes = (client: HomebridgeClient) => requireGlassUi('Scenes', () => client.listScenes());

/** Finds a scene by id, else by exact (case-insensitive) name. */
function findScene(scenes: Scene[], ref: string): Scene | undefined {
  return scenes.find((s) => s.id === ref) ?? scenes.find((s) => s.name.toLowerCase() === ref.toLowerCase());
}

export const register: RegisterTools = (tool, client) => {
  tool(
    'list_scenes',
    {
      title: 'List scenes',
      description:
        'List the Homebridge Glass UI scenes: named sets of accessory values applied together, with their actions, cron schedules and last run. Requires Homebridge Glass UI.',
      outputSchema: SCENE_LIST,
      annotations: READ,
    },
    handle('listing scenes', async () => {
      const scenes = await listScenes(client);
      return structuredResult({ scenes }, scenes);
    }),
  );

  tool(
    'run_scene',
    {
      title: 'Run scene',
      description:
        'Run a Homebridge Glass UI scene now: every action is applied and the result per action is returned. ' +
        'A scene that unlocks, opens or disarms something needs confirm=true, which you may only pass after the user has explicitly agreed.',
      inputSchema: {
        scene: z.string().min(1).describe('The scene id or name from list_scenes'),
        confirm: z.boolean().optional().describe('Required for a scene that changes a lock, garage door or security system, after the user agreed.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handle('running scene', async ({ scene: ref, confirm }) => {
      const scenes = await listScenes(client);
      const scene = findScene(scenes, ref);
      if (!scene) {
        return errorResult(`No scene "${ref}". Scenes: ${scenes.map((s) => s.name).join(', ') || 'none'}.`);
      }
      const sensitive = scene.actions.filter((a) => isSecurityCharacteristic(a.characteristicType));
      if (sensitive.length && !confirm) {
        return errorResult(
          `Scene "${scene.name}" changes ${sensitive.map((a) => a.characteristicType).join(', ')} (a lock, door or alarm). ` +
            'Ask the user to confirm, then call run_scene again with confirm=true.',
        );
      }
      return jsonResult({ name: scene.name, ...(await client.runScene(scene.id)) });
    }),
  );

  tool(
    'save_scene',
    {
      title: 'Save scene from current state',
      description:
        'Create a Homebridge Glass UI scene from the current values of the chosen accessories, so the user can bring this state back later with run_scene. ' +
        'By default every writable characteristic is captured; pass `characteristics` to keep only some (e.g. On, Brightness). ' +
        'Lock, garage door and security system states are never captured. Pass dryRun=true to see the actions first. Requires Homebridge Glass UI (admin).',
      inputSchema: {
        name: z.string().trim().min(1).max(64).describe('The scene name'),
        uniqueIds: z.array(z.string().min(1)).min(1).max(MAX_SCENE_ACTIONS).describe('The accessories to capture (from list_accessories)'),
        characteristics: z.array(z.string().min(1)).min(1).optional().describe("Only capture these characteristic types, e.g. ['On', 'Brightness']"),
        dryRun: z.boolean().optional().describe('Only return the actions that would be saved.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle('saving scene', async ({ name, uniqueIds, characteristics, dryRun }) => {
      const wanted = characteristics && new Set(characteristics.map((c) => c.toLowerCase()));
      const byId = new Map((await client.getAccessories()).map((a) => [a.uniqueId, a]));
      const actions: Scene['actions'] = [];
      const skipped: Array<{ uniqueId: string; reason: string }> = [];
      for (const uniqueId of new Set(uniqueIds)) {
        const accessory = byId.get(uniqueId);
        if (!accessory) {
          skipped.push({ uniqueId, reason: 'no such accessory' });
          continue;
        }
        const captured = (accessory.serviceCharacteristics ?? []).filter((c) => {
          const type = c.type.toLowerCase();
          return (
            c.canWrite !== false &&
            !NOT_STATE.has(type) &&
            !isSecurityCharacteristic(type) &&
            (!wanted || wanted.has(type)) &&
            c.format !== 'tlv8' &&
            c.format !== 'data' &&
            isSceneValue(c.value)
          );
        });
        if (!captured.length) {
          skipped.push({ uniqueId, reason: 'nothing to capture' });
        }
        actions.push(...captured.map((c) => ({ uniqueId, characteristicType: c.type, value: c.value as SceneValue })));
      }

      if (actions.length === 0) {
        return errorResult(`Nothing to save: ${skipped.map((s) => `${s.uniqueId} (${s.reason})`).join(', ')}.`);
      }
      if (actions.length > MAX_SCENE_ACTIONS) {
        return errorResult(
          `That is ${actions.length} actions; a scene holds at most ${MAX_SCENE_ACTIONS}. Pass fewer accessories or limit \`characteristics\`.`,
        );
      }
      if (dryRun) {
        return jsonResult({ dryRun: true, name, actions, skipped });
      }
      const created = await requireGlassUi('Saving a scene', () => client.createScene({ name, actions, schedules: [] }));
      return jsonResult({ created, skipped });
    }),
  );
};
