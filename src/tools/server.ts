import { z } from 'zod';
import type { RegisterTools } from '../types.js';
import { READ, handle, jsonResult, pick, textResult } from './helpers.js';

const CACHED_ACCESSORY_FIELDS = ['UUID', 'displayName', 'plugin', 'platform', 'category'] as const;

export const register: RegisterTools = (tool, client) => {
  tool(
    'get_homebridge_status',
    {
      title: 'Homebridge status',
      description: 'Check if Homebridge is running and get its current status (up/down, version, plugins status).',
      annotations: READ,
    },
    handle('getting Homebridge status', async () => jsonResult(await client.getHomebridgeStatus())),
  );

  tool(
    'get_server_status',
    {
      title: 'Server information',
      description: 'Get Homebridge server information including version, Node.js version, uptime, OS details, and Homebridge instance ID.',
      annotations: READ,
    },
    handle('getting server info', async () => jsonResult(await client.getServerInformation())),
  );

  tool(
    'restart_homebridge',
    {
      title: 'Restart Homebridge',
      description: 'Restart the Homebridge service. This will temporarily make all accessories unavailable.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handle('restarting Homebridge', async () => {
      const result = await client.restartServer();
      return result ? jsonResult(result) : textResult('Homebridge restart initiated successfully.');
    }),
  );

  tool(
    'get_pairing_info',
    {
      title: 'HomeKit pairing info',
      description:
        'Get the HomeKit pairing information (setup code, QR code URL) for this Homebridge instance. ' +
        'The setup code lets anyone on the network pair with the bridge, so only fetch it when the user asks to pair a device.',
      annotations: READ,
    },
    handle('getting pairing info', async () => jsonResult(await client.getPairingInfo())),
  );

  tool(
    'get_cached_accessories',
    {
      title: 'List cached accessories',
      description:
        'List cached accessories stored by Homebridge (UUID, name, plugin, platform, category and cacheFile). These persist across restarts. ' +
        'Pass verbose=true for the full cached objects including services and context.',
      inputSchema: {
        verbose: z.boolean().optional().describe('Return the full cached accessory objects (large). Default false.'),
      },
      annotations: READ,
    },
    handle('getting cached accessories', async ({ verbose }) => {
      const cached = await client.getCachedAccessories();
      if (verbose) {
        return jsonResult(cached);
      }
      return jsonResult(cached.map((acc) => ({ ...pick(acc, CACHED_ACCESSORY_FIELDS), cacheFile: acc.$cacheFile })));
    }),
  );

  tool(
    'remove_cached_accessory',
    {
      title: 'Remove cached accessory',
      description:
        'Remove a specific cached accessory by its UUID. Useful for cleaning up stale accessories. ' +
        'Pass the cacheFile reported by get_cached_accessories for accessories that belong to a child bridge.',
      inputSchema: {
        uuid: z.string().min(1).describe('The UUID of the cached accessory to remove'),
        cacheFile: z
          .string()
          .optional()
          .describe('The cacheFile from get_cached_accessories. Omit for accessories on the main bridge.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handle('removing cached accessory', async ({ uuid, cacheFile }) => {
      await client.removeCachedAccessory(uuid, cacheFile);
      return textResult(`Cached accessory ${uuid} removed successfully.`);
    }),
  );

  tool(
    'reset_cached_accessories',
    {
      title: 'Reset all cached accessories',
      description: 'Reset ALL cached accessories. WARNING: This removes all cached accessories and requires a Homebridge restart.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handle('resetting cached accessories', async () => {
      await client.resetCachedAccessories();
      return textResult('All cached accessories have been reset. A Homebridge restart may be required.');
    }),
  );
};
