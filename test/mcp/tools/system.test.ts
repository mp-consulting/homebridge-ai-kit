import { describe, it, expect, vi } from 'vitest';
import { register } from '../../../src/mcp/tools/system.js';
import { collectHandlers, mockClient } from '../helpers.js';

const MB = 1024 * 1024;

const metrics = {
  cpu: { currentLoad: 23.456, cpuLoadHistory: [10, 20, 23.456], cpuTemperature: { main: 51.25 } },
  memory: { mem: { total: 4096 * MB, available: 1024 * MB } },
  network: { net: { iface: 'eth0', operstate: 'up', rx_sec: 2048, tx_sec: null } },
  uptime: { time: { current: Date.UTC(2026, 9, 22, 9, 30), uptime: 86400.7, timezone: 'GMT+0200' }, processUptime: 3600.2 },
};

async function call(getSystemInfo: ReturnType<typeof vi.fn>) {
  const result = await collectHandlers(register, mockClient({ getSystemInfo })).get('get_system_info')!({});
  return { result, parsed: result.isError ? undefined : JSON.parse(result.content[0].text) };
}

describe('system tools', () => {
  describe('get_system_info', () => {
    it('summarizes CPU, memory, network and uptime', async () => {
      const { parsed } = await call(vi.fn().mockResolvedValue(metrics));

      expect(parsed).toEqual({
        cpu: { loadPercent: 23.5, recentAvgLoadPercent: 17.8, recentMaxLoadPercent: 23.5, temperatureC: 51.3 },
        memory: { totalMB: 4096, availableMB: 1024, usedPercent: 75 },
        network: { interface: 'eth0', state: 'up', receivedKBps: 2, sentKBps: null },
        uptime: { hostSeconds: 86401, homebridgeUiSeconds: 3600, serverTime: '2026-10-22T09:30:00.000Z', timezone: 'GMT+0200' },
      });
    });

    it('reports no temperature when the host has no sensor (-1)', async () => {
      const { parsed } = await call(vi.fn().mockResolvedValue({ cpu: { ...metrics.cpu, cpuTemperature: { main: -1 } } }));

      expect(parsed.cpu.temperatureC).toBeNull();
    });

    it('answers null for values the UI left out', async () => {
      const { parsed } = await call(vi.fn().mockResolvedValue({ cpu: {}, memory: { mem: { total: 4096 * MB } }, network: { net: {} }, uptime: { time: {} } }));

      expect(parsed).toEqual({
        cpu: { loadPercent: null, recentAvgLoadPercent: null, recentMaxLoadPercent: null, temperatureC: null },
        memory: { totalMB: 4096, availableMB: null, usedPercent: null },
        network: { interface: null, state: null, receivedKBps: null, sentKBps: null },
        uptime: { hostSeconds: null, homebridgeUiSeconds: null, serverTime: null, timezone: null },
      });
    });

    it('says so when server metrics monitoring is off', async () => {
      const { parsed } = await call(
        vi.fn().mockResolvedValue({
          cpu: { currentLoad: 0, cpuLoadHistory: [], cpuTemperature: { main: -1 } },
          memory: { mem: null, memoryUsageHistory: [] },
          uptime: metrics.uptime,
        }),
      );

      expect(parsed).not.toHaveProperty('cpu');
      expect(parsed).not.toHaveProperty('memory');
      expect(parsed.uptime.homebridgeUiSeconds).toBe(3600);
      expect(parsed.note).toMatch(/monitoring is turned off/);
    });

    it('passes on the parts whose route failed', async () => {
      const { parsed } = await call(vi.fn().mockResolvedValue({ uptime: metrics.uptime, errors: { cpu: 'HTTP 500' } }));

      expect(parsed).not.toHaveProperty('cpu');
      expect(parsed.errors).toEqual({ cpu: 'HTTP 500' });
    });

    it('handles errors', async () => {
      const { result } = await call(vi.fn().mockRejectedValue(new Error('fail')));

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error getting system info: fail');
    });
  });
});
