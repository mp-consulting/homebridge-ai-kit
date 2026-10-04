import { z } from 'zod';
import type { RegisterTools } from '../types.js';
import { READ, READ_REGISTRY, handle, jsonResult, pick, structuredResult, untrustedResult } from './helpers.js';
import { PLUGIN_LIST } from './output-schemas.js';

const INSTALLED_FIELDS = [
  'name',
  'displayName',
  'installedVersion',
  'latestVersion',
  'updateAvailable',
  'verifiedPlugin',
  'disabled',
] as const;

const SEARCH_FIELDS = [
  'name',
  'displayName',
  'description',
  'latestVersion',
  'lastUpdated',
  'verifiedPlugin',
  'installedVersion',
] as const;

const pluginName = z.string().min(1).describe("The npm package name of the plugin (e.g. 'homebridge-hue')");
const verbose = z.boolean().optional().describe('Return every field the API provides (large). Default false.');

export const register: RegisterTools = (tool, client) => {
  tool(
    'list_plugins',
    {
      title: 'List installed plugins',
      description:
        'List all currently installed Homebridge plugins with their versions and update status. ' +
        'Pass verbose=true for every field (links, engines, install path, keywords, ...).',
      inputSchema: { verbose },
      outputSchema: PLUGIN_LIST,
      annotations: READ,
    },
    handle('listing plugins', async ({ verbose }) => {
      const plugins = await client.getPlugins();
      const list = verbose ? plugins : plugins.map((p) => pick(p, INSTALLED_FIELDS));
      return structuredResult({ plugins: list }, list);
    }),
  );

  tool(
    'search_plugins',
    {
      title: 'Search plugins',
      description: 'Search the npm registry for Homebridge plugins matching a query. Pass verbose=true for every field.',
      inputSchema: {
        query: z.string().min(1).describe("Search query (e.g. 'hue', 'camera', 'thermostat')"),
        verbose,
      },
      annotations: READ_REGISTRY,
    },
    handle('searching plugins', async ({ query, verbose }) => {
      const results = await client.searchPlugins(query);
      return jsonResult(verbose ? results : results.map((p) => pick(p, SEARCH_FIELDS)));
    }),
  );

  tool(
    'lookup_plugin',
    {
      title: 'Look up plugin',
      description: 'Get detailed information about a specific Homebridge plugin from the npm registry.',
      inputSchema: { pluginName },
      annotations: READ_REGISTRY,
    },
    handle('looking up plugin', async ({ pluginName }) => jsonResult(await client.lookupPlugin(pluginName))),
  );

  tool(
    'get_plugin_versions',
    {
      title: 'Plugin versions',
      description: 'Get available versions and dist-tags for a specific Homebridge plugin.',
      inputSchema: { pluginName },
      annotations: READ_REGISTRY,
    },
    handle('getting plugin versions', async ({ pluginName }) => jsonResult(await client.getPluginVersions(pluginName))),
  );

  tool(
    'get_plugin_config_schema',
    {
      title: 'Plugin config schema',
      description: 'Get the config.schema.json for a plugin, which describes how to configure it in Homebridge.',
      inputSchema: { pluginName },
      annotations: READ,
    },
    handle('getting plugin config schema', async ({ pluginName }) => jsonResult(await client.getPluginConfigSchema(pluginName))),
  );

  tool(
    'get_plugin_changelog',
    {
      title: 'Plugin changelog',
      description: 'Get the CHANGELOG.md content for an installed Homebridge plugin.',
      inputSchema: { pluginName },
      annotations: READ,
    },
    handle('getting plugin changelog', async ({ pluginName }) => {
      const changelog = await client.getPluginChangelog(pluginName);
      return typeof changelog === 'string' ? untrustedResult(`changelog:${pluginName}`, changelog) : jsonResult(changelog);
    }),
  );
};
