import { z } from 'zod';
import type { RegisterTools } from '../types.js';
import { requireGlassUi } from '../homebridge-client.js';
import { READ, handle, pick, structuredResult, textResult } from './helpers.js';
import { CHILD_BRIDGE_HEALTH, CHILD_BRIDGE_LIST } from './output-schemas.js';

/** What is shown of a child bridge: never its HomeKit/Matter pairing codes. */
export const CHILD_BRIDGE_FIELDS = ['username', 'name', 'plugin', 'identifier', 'status', 'paired', 'pid', 'port', 'manuallyStopped'] as const;

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
      outputSchema: CHILD_BRIDGE_LIST,
      annotations: READ,
    },
    handle('listing child bridges', async () => {
      const list = (await client.getChildBridges()).map((b) => pick(b, CHILD_BRIDGE_FIELDS));
      return structuredResult({ childBridges: list }, list);
    }),
  );

  tool(
    'get_child_bridge_health',
    {
      title: 'Child bridge health',
      description:
        'Health of each child bridge: status, uptime, restart and crash counts, and whether it is crash-looping (3 unrequested crashes in 10 minutes). ' +
        'Counts start when the UI starts. Pass deviceId for one bridge. Requires Homebridge Glass UI (admin).',
      inputSchema: { deviceId: deviceId.optional() },
      outputSchema: CHILD_BRIDGE_HEALTH,
      annotations: READ,
    },
    handle('getting child bridge health', async ({ deviceId }) => {
      const report = await requireGlassUi('Child bridge health', () => client.getChildBridgeHealth());
      if (!deviceId) {
        return structuredResult({ ...report });
      }
      const norm = (id: string) => id.replace(/:/g, '').toUpperCase();
      const bridges = report.bridges.filter((b) => norm(b.username) === norm(deviceId));
      return structuredResult({ ...report, bridges });
    }),
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
