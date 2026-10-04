import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PROMPTS } from '@mp-consulting/homebridge-ai-core';

function message(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/** MCP prompts sharing their text with the built-in Assistant's templates. */
export function registerPrompts(server: McpServer): void {
  const p = PROMPTS.mcp;

  server.registerPrompt(
    'diagnose-logs',
    {
      title: p['diagnose-logs'].title,
      description: p['diagnose-logs'].description,
      argsSchema: { focus: z.string().optional().describe('A plugin, device or symptom to focus on') },
    },
    ({ focus }) => message(p['diagnose-logs'].text({ focus })),
  );

  server.registerPrompt(
    'plan-upgrade',
    {
      title: p['plan-upgrade'].title,
      description: p['plan-upgrade'].description,
      argsSchema: { plugin: z.string().optional().describe('One plugin to plan for (default: all with updates)') },
    },
    ({ plugin }) => message(p['plan-upgrade'].text({ plugin })),
  );

  server.registerPrompt(
    'audit-config',
    { title: p['audit-config'].title, description: p['audit-config'].description },
    () => message(p['audit-config'].text()),
  );

  registerWorkflowPrompts(server);
}

/**
 * Multi-step workflow prompts. Their text lives here rather than in ai-core's PROMPTS because
 * they name tools only this MCP server has (scenes, health, backups).
 */
export const WORKFLOW_PROMPTS = {
  'troubleshoot-device': {
    title: 'Troubleshoot a device',
    description: 'Find out why one accessory misbehaves: its state, its plugin, child bridge health and the related log lines.',
    text: ({ device, symptom }: { device: string; symptom?: string }) =>
      `Troubleshoot the Homebridge accessory "${device}"${symptom ? ` (symptom: ${symptom})` : ''}. ` +
      'Steps: 1) find it with list_accessories (name filter) and read it with get_accessory: note unreachable/fault values and odd characteristics. ' +
      '2) Work out which plugin provides it (manufacturer, list_plugins, list_child_bridges); check get_child_bridge_health for crashes or a crash loop if it runs on a child bridge. ' +
      '3) search_logs for the device name and for the plugin prefix with level "warn", since "24h", context 2. ' +
      '4) If it is a sensor, get_accessory_history shows when it stopped reporting. ' +
      'Explain the most likely cause and the fix, most likely first. Only change anything (restart a child bridge, set a value, edit config) after the user agrees; ' +
      'use dryRun for config changes and show the diff first.',
  },
  'nightly-health-check': {
    title: 'Nightly health check',
    description: 'A short report on Homebridge health: status, child bridges, errors in the last day, plugin updates and backups.',
    text: ({ hours }: { hours?: string }) => {
      const window = hours ? `${hours}h` : '24h';
      return (
        'Run a read-only Homebridge health check and write a short report. ' +
        '1) get_homebridge_status and get_server_status. ' +
        '2) list_child_bridges and get_child_bridge_health (skip if unavailable): flag down bridges, crash loops, many restarts. ' +
        `3) search_logs with level "error" and since "${window}" (limit 200): group the errors by plugin and count them; ` +
        'then level "warn" for anything recurring. ' +
        '4) list_plugins: plugins with updates available. 5) list_backups (skip if unavailable): is the newest backup less than two days old? ' +
        '6) get_system_info: low disk space or memory. ' +
        'Report: an overall verdict (healthy / needs attention / broken), then one line per finding with the suggested action. Change nothing.'
      );
    },
  },
  'scene-builder': {
    title: 'Build a scene',
    description: 'Turn a description ("cosy movie night in the living room") into a saved Homebridge Glass UI scene.',
    text: ({ description, room }: { description: string; room?: string }) =>
      `Build a Homebridge scene for: "${description}"${room ? ` in the room "${room}"` : ''}. ` +
      `1) list_accessories${room ? ` with room "${room}"` : ''} to find the relevant lights, switches, blinds, thermostats and so on, and list_scenes to avoid a duplicate name. ` +
      '2) Propose the values (On, Brightness, ColorTemperature, TargetPosition, TargetTemperature, ...) as a short table and ask the user to confirm or adjust. ' +
      '3) Either apply them with set_accessories (dryRun first) and then save the result with save_scene, limiting `characteristics` to the ones you set, ' +
      'or, if the user does not want to change the devices now, describe the scene they can create in the Glass UI. ' +
      'Never include locks, garage doors or alarms. Finish by telling the user how to run it (run_scene).',
  },
} as const;

function registerWorkflowPrompts(server: McpServer): void {
  const w = WORKFLOW_PROMPTS;
  server.registerPrompt(
    'troubleshoot-device',
    {
      title: w['troubleshoot-device'].title,
      description: w['troubleshoot-device'].description,
      argsSchema: {
        device: z.string().describe('The accessory name or uniqueId'),
        symptom: z.string().optional().describe('What goes wrong, e.g. "No Response in Home app"'),
      },
    },
    (args) => message(w['troubleshoot-device'].text(args)),
  );

  server.registerPrompt(
    'nightly-health-check',
    {
      title: w['nightly-health-check'].title,
      description: w['nightly-health-check'].description,
      argsSchema: { hours: z.string().regex(/^\d{1,3}$/).optional().describe('How many hours of log to check (default 24)') },
    },
    (args) => message(w['nightly-health-check'].text(args)),
  );

  server.registerPrompt(
    'scene-builder',
    {
      title: w['scene-builder'].title,
      description: w['scene-builder'].description,
      argsSchema: {
        description: z.string().describe('The mood or purpose, e.g. "movie night"'),
        room: z.string().optional().describe('Limit the scene to this room'),
      },
    },
    (args) => message(w['scene-builder'].text(args)),
  );
}
