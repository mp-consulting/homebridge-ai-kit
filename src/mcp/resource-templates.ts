import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { HomebridgeClient } from './homebridge-client.js';
import { CHILD_BRIDGE_FIELDS } from './tools/child-bridges.js';
import { pick } from './tools/helpers.js';

export const RESOURCE_TEMPLATES = {
  accessory: 'homebridge://accessory/{uniqueId}',
  plugin: 'homebridge://plugin/{+name}',
  childBridge: 'homebridge://child-bridge/{id}',
} as const;

/** Completion suggestions are capped at this many values (the MCP limit is 100). */
const MAX_COMPLETIONS = 50;

function json(uri: string, data: unknown) {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data) }] };
}

function variable(variables: Variables, name: string): string {
  const value = variables[name];
  return decodeURIComponent(Array.isArray(value) ? value.join(',') : value);
}

/** A list that never fails `resources/list`: a Homebridge error or odd answer just lists nothing. */
async function safeList<T>(fetch: () => Promise<T[]>): Promise<T[]> {
  try {
    const items = await fetch();
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function completeFrom(values: string[], typed: string): string[] {
  const t = typed.toLowerCase();
  return values.filter((v) => v.toLowerCase().includes(t)).slice(0, MAX_COMPLETIONS);
}

const normBridge = (id: string) => id.replace(/:/g, '').toUpperCase();

function notFound(what: string): never {
  throw new McpError(ErrorCode.InvalidParams, `${what} not found`);
}

/**
 * Per-item resources: one accessory, one installed plugin and one child bridge,
 * each listed in `resources/list` and with completion for its variable.
 */
export function registerResourceTemplates(server: McpServer, client: HomebridgeClient): void {
  const accessories = () => safeList(() => client.getAccessories());
  const plugins = () => safeList(() => client.getPlugins());
  const bridges = () => safeList(() => client.getChildBridges());

  server.registerResource(
    'accessory',
    new ResourceTemplate(RESOURCE_TEMPLATES.accessory, {
      list: async () => ({
        resources: (await accessories()).map((a) => ({
          uri: `homebridge://accessory/${encodeURIComponent(a.uniqueId)}`,
          name: a.serviceName,
          description: `${a.type} accessory`,
          mimeType: 'application/json',
        })),
      }),
      complete: { uniqueId: async (typed) => completeFrom((await accessories()).map((a) => a.uniqueId), typed) },
    }),
    { title: 'Accessory', description: 'One accessory with every characteristic, its metadata and current value.', mimeType: 'application/json' },
    async (uri, variables) => json(uri.href, await client.getAccessory(variable(variables, 'uniqueId'))),
  );

  server.registerResource(
    'plugin',
    new ResourceTemplate(RESOURCE_TEMPLATES.plugin, {
      list: async () => ({
        resources: (await plugins()).map((p) => ({
          uri: `homebridge://plugin/${encodeURIComponent(p.name)}`,
          name: p.name,
          description: typeof p.description === 'string' ? p.description : undefined,
          mimeType: 'application/json',
        })),
      }),
      complete: { name: async (typed) => completeFrom((await plugins()).map((p) => p.name), typed) },
    }),
    { title: 'Installed plugin', description: 'One installed plugin: version, update status, links and the child bridges it runs.', mimeType: 'application/json' },
    async (uri, variables) => {
      const name = variable(variables, 'name');
      const [plugin, childBridges] = await Promise.all([
        client.getPlugins().then((list) => list.find((p) => p.name === name)),
        bridges(),
      ]);
      return json(uri.href, { ...(plugin ?? notFound(`Plugin ${name}`)), childBridges: childBridges.filter((b) => b.plugin === name) });
    },
  );

  server.registerResource(
    'child-bridge',
    new ResourceTemplate(RESOURCE_TEMPLATES.childBridge, {
      list: async () => ({
        resources: (await bridges()).map((b) => ({
          uri: `homebridge://child-bridge/${encodeURIComponent(b.username)}`,
          name: b.name,
          description: `Child bridge of ${b.plugin} (${b.status})`,
          mimeType: 'application/json',
        })),
      }),
      complete: { id: async (typed) => completeFrom((await bridges()).map((b) => b.username), typed) },
    }),
    {
      title: 'Child bridge',
      description: 'One child bridge (by username): status and, with Homebridge Glass UI, its uptime, restart and crash counts.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = normBridge(variable(variables, 'id'));
      const [bridge, health] = await Promise.all([
        client.getChildBridges().then((list) => list.find((b) => normBridge(b.username) === id)),
        client.getChildBridgeHealth().then(
          (r) => r.bridges.find((b) => normBridge(b.username) === id),
          () => undefined,
        ),
      ]);
      return json(uri.href, { ...pick(bridge ?? notFound(`Child bridge ${id}`), CHILD_BRIDGE_FIELDS), ...(health ? { health } : {}) });
    },
  );
}
