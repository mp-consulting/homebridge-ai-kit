import type { RegisterTools } from '../types.js';
import { READ, handle, jsonResult } from './helpers.js';

export const register: RegisterTools = (tool, client) => {
  tool(
    'get_system_info',
    {
      title: 'Host system info',
      description: 'Get system information for the machine running Homebridge (CPU, memory, OS, network interfaces, uptime).',
      annotations: READ,
    },
    handle('getting system info', async () => jsonResult(await client.getSystemInfo())),
  );
};
