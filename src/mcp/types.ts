import type { HomebridgeClient } from './homebridge-client.js';
import type { ToolRegistrar } from './tools/helpers.js';

/**
 * Signature for tool registration functions.
 * Each tools/*.ts file exports a `register` function matching this type.
 */
export type RegisterTools = (tool: ToolRegistrar, client: HomebridgeClient) => void;

// ── Homebridge UI API shapes ──────────────────────────────────────
// Only the fields this server reads are typed; the API returns more.

export interface Accessory {
  uniqueId: string;
  serviceName: string;
  type: string;
  accessoryInformation?: { Manufacturer?: string; Model?: string; Name?: string };
  serviceCharacteristics?: CharacteristicInfo[];
  values?: Record<string, unknown>;
}

export interface Room {
  name: string;
  services: Array<{ uniqueId: string; customName?: string }>;
}

export interface CachedAccessory {
  UUID: string;
  displayName?: string;
  plugin?: string;
  platform?: string;
  category?: number;
  /** Added by the UI: which cache file (main bridge or a child bridge) holds this accessory. */
  $cacheFile?: string;
  [key: string]: unknown;
}

export type Plugin = Record<string, unknown> & { name: string };

/** Characteristic metadata as the Homebridge UI reports it. */
export interface CharacteristicInfo {
  type: string;
  value: unknown;
  format?: string;
  canWrite?: boolean;
  minValue?: number;
  maxValue?: number;
  minStep?: number;
  maxLen?: number;
  validValues?: number[];
  description?: string;
  unit?: string;
}

export interface PluginJob {
  id: string;
  action: 'install' | 'update' | 'uninstall';
  name: string;
  status: 'running' | 'succeeded' | 'failed';
  output: string;
  startedAt: string;
  finishedAt?: string;
}

export interface ChildBridge {
  username: string;
  name: string;
  plugin: string;
  identifier?: string;
  status: 'pending' | 'ok' | 'down' | string;
  paired?: boolean | null;
  pid?: number;
  port?: number;
  manuallyStopped?: boolean;
  [key: string]: unknown;
}
