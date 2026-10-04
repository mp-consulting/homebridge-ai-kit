import { describe, expect, it, vi } from 'vitest';
import { register } from '../../../src/mcp/tools/notifications.js';
import { HomebridgeApiError } from '../../../src/mcp/homebridge-client.js';
import { collectHandlers, mockClient } from '../helpers.js';

describe('send_test_notification', () => {
  it('sends to one channel and returns the results', async () => {
    const client = mockClient({ sendTestNotification: vi.fn().mockResolvedValue([{ channel: 'ntfy', ok: true }]) });
    const result = await collectHandlers(register, client).get('send_test_notification')!({ channel: 'ntfy' });
    expect(client.sendTestNotification).toHaveBeenCalledWith('ntfy');
    expect(JSON.parse(result.content[0].text)).toEqual([{ channel: 'ntfy', ok: true }]);
  });

  it('needs Glass UI', async () => {
    const error = new HomebridgeApiError(404, 'POST', '/api/notifications/test', 'Cannot POST /api/notifications/test');
    const client = mockClient({ sendTestNotification: vi.fn().mockRejectedValue(error) });
    const result = await collectHandlers(register, client).get('send_test_notification')!({});
    expect(result.content[0].text).toContain('Notifications requires Homebridge Glass UI');
  });
});
