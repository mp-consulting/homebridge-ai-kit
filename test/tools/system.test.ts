import { describe, it, expect, vi } from 'vitest';
import { register } from '../../src/tools/system.js';
import { collectHandlers, mockClient } from '../helpers.js';

describe('system tools', () => {
  describe('get_system_info', () => {
    it('returns system info', async () => {
      const client = mockClient({
        getSystemInfo: vi.fn().mockResolvedValue({ cpu: { model: 'ARM' }, memory: { total: 4096 } }),
      });
      const result = await collectHandlers(register, client).get('get_system_info')!({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.cpu.model).toBe('ARM');
      expect(parsed.memory.total).toBe(4096);
    });

    it('handles errors', async () => {
      const client = mockClient({ getSystemInfo: vi.fn().mockRejectedValue(new Error('fail')) });
      const result = await collectHandlers(register, client).get('get_system_info')!({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error getting system info: fail');
    });
  });
});
