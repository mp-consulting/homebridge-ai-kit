import { z } from 'zod';
import type { RegisterTools } from '../types.js';
import { READ, handle, jsonResult, pick, textResult } from './helpers.js';

const FIELDS = ['username', 'name', 'plugin', 'identifier', 'status', 'paired', 'pid', 'port', 'manuallyStopped'] as const;

const deviceId = z
  .string()
  .regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$|^[0-9A-Fa-f]{12}$/, 'must be a child bridge username like 0E:3C:12:AB:CD:EF')
  .describe('The child bridge username (deviceId) from list_child_bridges');

export const register: RegisterTools = (tool, client) => {
  tool(
    'list_child_bridges',
    {
      title: 'List child bridges',
      description: 'List the child bridges (plugins running in their own process) with their status (ok, pending, down) and whether they were stopped manually.',
      annotations: READ,
    },
    handle('listing child bridges', async () => jsonResult((await client.getChildBridges()).map((b) => pick(b, FIELDS)))),
  );

  const control = (action: 'restart' | 'stop' | 'start', title: string, description: string) =>
    tool(
      `${action}_child_bridge`,
      {
        title,
        description,
        inputSchema: { deviceId },
        // Starting only brings accessories back; stopping and restarting interrupt them.
        annotations: { readOnlyHint: false, destructiveHint: action !== 'start', idempotentHint: true, openWorldHint: false },
      },
      handle(`${action === 'stop' ? 'stopp' : action}ing child bridge`, async ({ deviceId }) => {
        await client.controlChildBridge(action, deviceId);
        return textResult(`Child bridge ${deviceId}: ${action} requested. Check list_child_bridges for its status.`);
      }),
    );

  control('restart', 'Restart child bridge', 'Restart one child bridge without restarting Homebridge. Its accessories are briefly unavailable.');
  control('stop', 'Stop child bridge', 'Stop one child bridge. Its accessories stay unavailable until it is started again.');
  control('start', 'Start child bridge', 'Start a child bridge that was stopped.');
};
