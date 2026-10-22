import type { RegisterTools, SystemInfo } from '../types.js';
import { READ, handle, jsonResult, round } from './helpers.js';

const MB = 1024 * 1024;

const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Condenses the UI's metrics: the load and memory histories are summarized, not returned. */
function summarizeSystemInfo({ cpu, memory, network, uptime, errors }: SystemInfo) {
  const history = (cpu?.cpuLoadHistory ?? []).filter(num);
  const temperature = cpu?.cpuTemperature?.main;
  const mem = memory?.mem;
  const net = network?.net;
  const time = uptime?.time;
  // Glass UI answers zero load, no history and no memory when metrics monitoring is off.
  const monitoringOff = memory !== undefined && mem === null && history.length === 0;
  return {
    ...(cpu && !monitoringOff
      ? {
        cpu: {
          loadPercent: num(cpu.currentLoad) ? round(cpu.currentLoad, 1) : null,
          recentAvgLoadPercent: history.length ? round(history.reduce((a, b) => a + b, 0) / history.length, 1) : null,
          recentMaxLoadPercent: history.length ? round(Math.max(...history), 1) : null,
          temperatureC: num(temperature) && temperature >= 0 ? round(temperature, 1) : null,
        },
      }
      : {}),
    ...(mem && num(mem.total) && mem.total > 0
      ? {
        memory: {
          totalMB: Math.round(mem.total / MB),
          availableMB: num(mem.available) ? Math.round(mem.available / MB) : null,
          usedPercent: num(mem.available) ? round((1 - mem.available / mem.total) * 100, 1) : null,
        },
      }
      : {}),
    ...(net
      ? {
        network: {
          interface: net.iface ?? null,
          state: net.operstate ?? null,
          receivedKBps: num(net.rx_sec) ? round(net.rx_sec / 1024, 1) : null,
          sentKBps: num(net.tx_sec) ? round(net.tx_sec / 1024, 1) : null,
        },
      }
      : {}),
    ...(uptime
      ? {
        uptime: {
          hostSeconds: num(time?.uptime) ? Math.round(time.uptime) : null,
          homebridgeUiSeconds: num(uptime.processUptime) ? Math.round(uptime.processUptime) : null,
          serverTime: num(time?.current) ? new Date(time.current).toISOString() : null,
          timezone: time?.timezone ?? null,
        },
      }
      : {}),
    ...(monitoringOff ? { note: 'Server metrics monitoring is turned off in the Homebridge UI settings, so CPU and memory are not available.' } : {}),
    ...(errors ? { errors } : {}),
  };
}

export const register: RegisterTools = (tool, client) => {
  tool(
    'get_system_info',
    {
      title: 'Host system info',
      description:
        'Get the load of the machine running Homebridge: CPU load (now, recent average and peak) and temperature, memory total, available and used %, ' +
        'network throughput on the default interface, host and Homebridge UI uptime, and the server time. ' +
        'Use it to check whether the host is overloaded or short of memory; for Node.js, OS and paths use get_server_status. ' +
        'CPU and memory are missing when server metrics monitoring is turned off in the Homebridge UI.',
      annotations: READ,
    },
    handle('getting system info', async () => jsonResult(summarizeSystemInfo(await client.getSystemInfo()))),
  );
};
