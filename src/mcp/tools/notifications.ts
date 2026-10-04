import { z } from 'zod';
import { requireGlassUi } from '../homebridge-client.js';
import type { RegisterTools } from '../types.js';
import { handle, jsonResult } from './helpers.js';

export const register: RegisterTools = (tool, client) => {
  tool(
    'send_test_notification',
    {
      title: 'Send test notification',
      description:
        'Send a test message through the Homebridge Glass UI notification channels (webhook, ntfy, Pushover, Telegram) to check they work. ' +
        'Without `channel` it goes to every enabled channel. Returns the result per channel. Rate-limited by the UI. Requires Homebridge Glass UI (admin).',
      inputSchema: {
        channel: z.enum(['webhook', 'ntfy', 'pushover', 'telegram']).optional().describe('Only this channel'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    handle('sending test notification', async ({ channel }) =>
      jsonResult(await requireGlassUi('Notifications', () => client.sendTestNotification(channel))),
    ),
  );
};
