import { z } from 'zod';
import type { RegisterTools } from '../types.js';
import { READ, asObject, handle, jsonResult, pick, structuredResult, textResult } from './helpers.js';
import { SERVER_INFO, STATUS } from './output-schemas.js';

const CACHED_ACCESSORY_FIELDS = ['UUID', 'displayName', 'plugin', 'platform', 'category'] as const;

export const register: RegisterTools = (tool, client) => {
  tool(
    'get_homebridge_status',
    {
      title: 'Homebridge status',
      description:
        'Check whether the Homebridge process is running: returns status up, pending (starting or restarting) or down. ' +
        'Use it after restart_homebridge to see when Homebridge is back. ' +
        'For versions, paths and OS use get_server_status; for plugins running in their own process use list_child_bridges.',
      outputSchema: STATUS,
      annotations: READ,
    },
    handle('getting Homebridge status', async () => {
      const status = await client.getHomebridgeStatus();
      return structuredResult(asObject(status), status);
    }),
  );

  tool(
    'get_server_status',
    {
      title: 'Server information',
      description:
        'Get details of the server Homebridge runs on: Node.js version, OS, service user, config.json, storage and plugin paths, ' +
        'whether it runs in Docker, a Synology package or package mode, insecure mode, server time and the default network interface ' +
        '(paths need an admin Homebridge token). Use it to check the environment, e.g. before installing a plugin; ' +
        'whether Homebridge is running is get_homebridge_status.',
      outputSchema: SERVER_INFO,
      annotations: READ,
    },
    handle('getting server info', async () => {
      const info = await client.getServerInformation();
      return structuredResult(asObject(info), info);
    }),
  );

  tool(
    'restart_homebridge',
    {
      title: 'Restart Homebridge',
      description:
        'Restart the whole Homebridge service, e.g. to load a config change or a newly installed plugin. ' +
        'Every accessory is unavailable while it restarts. Returns once the restart is requested; poll get_homebridge_status until it is up. ' +
        'To reload one plugin that runs as a child bridge, use restart_child_bridge instead.',
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
        'Use it to find stale accessories (e.g. from a removed plugin) to delete with remove_cached_accessory; for live state use list_accessories. ' +
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
      description:
        'Delete ALL cached accessories; Homebridge must restart afterwards. HomeKit may then see them as new accessories and lose their ' +
        'Home app rooms, names and automations. Only use it when the user asks for a full reset; for one stale accessory use remove_cached_accessory.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handle('resetting cached accessories', async () => {
      await client.resetCachedAccessories();
      return textResult('All cached accessories have been reset. A Homebridge restart may be required.');
    }),
  );
};
