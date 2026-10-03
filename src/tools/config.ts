import { z } from 'zod';
import type { RegisterTools } from '../types.js';
import { REDACTED, containsRedacted, redactSecrets, restoreSecrets } from '../config-secrets.js';
import { READ, handle, jsonResult, textResult } from './helpers.js';

/**
 * The minimum shape Homebridge needs. Extra keys pass through untouched; this
 * only stops an empty or truncated object from replacing the whole file.
 */
const configSchema = z.looseObject({
  bridge: z.looseObject({}).describe('The bridge block (name, username, port, pin, ...)'),
  accessories: z.array(z.looseObject({})).optional(),
  platforms: z.array(z.looseObject({})).optional(),
});

export const register: RegisterTools = (tool, client) => {
  tool(
    'get_config',
    {
      title: 'Read config.json',
      description:
        'Read the current Homebridge config.json file content. Returns the full configuration including bridge settings, accessories, and platforms. ' +
        `Passwords, tokens, API keys and the bridge pin are replaced by "${REDACTED}"; leave those placeholders as-is when calling update_config ` +
        'and the real values are kept.',
      inputSchema: {
        includeSecrets: z
          .boolean()
          .optional()
          .describe('Return real secret values instead of placeholders. Only use when the user explicitly asks to see a credential.'),
      },
      annotations: READ,
    },
    handle('getting config', async ({ includeSecrets }) => {
      const config = await client.getConfig();
      return jsonResult(includeSecrets ? config : redactSecrets(config));
    }),
  );

  tool(
    'update_config',
    {
      title: 'Write config.json',
      description:
        'Update the Homebridge config.json file. You must provide the FULL config object — it replaces the entire file. ' +
        `Use get_config first to read the current config, then modify and pass back the complete object. "${REDACTED}" placeholders ` +
        'are swapped back to the current real values before saving.',
      inputSchema: {
        config: configSchema.describe('The complete config.json object to write'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handle('updating config', async ({ config }) => {
      const toWrite = containsRedacted(config) ? restoreSecrets(config, await client.getConfig()) : config;
      const result = await client.updateConfig(toWrite);
      return result
        ? jsonResult(result)
        : textResult('Config updated successfully. A Homebridge restart may be required for changes to take effect.');
    }),
  );
};
