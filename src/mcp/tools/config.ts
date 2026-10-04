import { z } from 'zod';
import type { RegisterTools } from '../types.js';
import { REDACTED, containsRedacted, redactSecrets, restoreSecrets } from '@mp-consulting/homebridge-ai-core';
import { READ, errorResult, handle, jsonResult, textResult } from './helpers.js';
import { previewConfigChange, writeConfig } from './config-backups.js';

const dryRun = z
  .boolean()
  .optional()
  .describe('Only return what would change (a redacted path list and unified diff) without writing anything.');

/**
 * The minimum shape Homebridge needs. Extra keys pass through untouched; this
 * only stops an empty or truncated object from replacing the whole file.
 */
const configSchema = z.looseObject({
  bridge: z.looseObject({}).describe('The bridge block (name, username, port, pin, ...)'),
  accessories: z.array(z.looseObject({})).optional(),
  platforms: z.array(z.looseObject({})).optional(),
});

type Block = Record<string, unknown>;

function isBlock(v: unknown): v is Block {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge: objects merge key by key, `null` deletes a key, anything else (arrays included) replaces. */
export function mergePatch(target: Block, patch: Block): Block {
  const out: Block = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else if (isBlock(value) && isBlock(out[key])) {
      out[key] = mergePatch(out[key] as Block, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function describeBlock(b: Block): string {
  return [b.platform && `platform=${b.platform}`, b.accessory && `accessory=${b.accessory}`, b.name && `name=${b.name}`].filter(Boolean).join(' ');
}

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
        'are swapped back to the current real values before saving. Pass dryRun=true first to review the diff. ' +
        'The Homebridge UI backs up the previous file on every save; the result names that backup for restore_config.',
      inputSchema: {
        config: configSchema.describe('The complete config.json object to write'),
        dryRun,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handle('updating config', async ({ config, dryRun }) => {
      const current = dryRun || containsRedacted(config) ? await client.getConfig() : undefined;
      const toWrite = (containsRedacted(config) ? restoreSecrets(config, current!) : config) as Record<string, unknown>;
      if (dryRun) {
        return jsonResult(previewConfigChange(current!, toWrite));
      }
      // The UI answers with the saved file, secrets included, so it is not echoed back.
      return textResult(
        await writeConfig(client, toWrite, 'Config updated successfully. A Homebridge restart may be required for changes to take effect.'),
      );
    }),
  );

  tool(
    'patch_config',
    {
      title: 'Edit one config block',
      description:
        'Change one platform or accessory block in config.json without sending the whole file. Identify the block by `platform` or `accessory` ' +
        '(plus `name` when several blocks share it). `patch` is deep-merged: objects merge, arrays and values replace, and null removes a key. ' +
        `"${REDACTED}" placeholders in the patch keep the current secret. Returns the updated block (secrets redacted) and the backup id ` +
        'restore_config can roll back to. Pass dryRun=true to see the redacted diff without writing.',
      inputSchema: {
        platform: z.string().min(1).optional().describe("The block's `platform` value, e.g. 'Camera-ffmpeg'"),
        accessory: z.string().min(1).optional().describe("The block's `accessory` value, for accessory plugins"),
        name: z.string().min(1).optional().describe("The block's `name`, to pick one of several blocks of the same platform"),
        patch: z.looseObject({}).describe('Keys to change'),
        dryRun,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handle('patching config', async ({ platform, accessory, name, patch, dryRun }) => {
      if (!platform === !accessory) {
        return errorResult('Pass exactly one of `platform` or `accessory`.');
      }
      const config = await client.getConfig();
      const listKey = platform ? 'platforms' : 'accessories';
      const idKey = platform ? 'platform' : 'accessory';
      const id = (platform ?? accessory)!;
      const list = Array.isArray(config[listKey]) ? (config[listKey] as unknown[]) : [];
      const matches = list
        .map((b, index) => ({ b, index }))
        .filter(({ b }) => isBlock(b) && b[idKey] === id && (name === undefined || b.name === name));
      if (matches.length === 0) {
        return errorResult(`No ${idKey} block "${id}"${name ? ` named "${name}"` : ''} in config.json.`);
      }
      if (matches.length > 1) {
        return errorResult(`Several ${idKey} blocks match "${id}": ${matches.map(({ b }) => describeBlock(b as Block)).join('; ')}. Pass \`name\` to pick one.`);
      }
      const { b, index } = matches[0];
      const current = b as Block;
      let updated = mergePatch(current, patch);
      if (containsRedacted(updated)) {
        updated = restoreSecrets(updated, current) as Block;
      }
      updated[idKey] = id;
      const nextList = [...list];
      nextList[index] = updated;
      const next = { ...config, [listKey]: nextList };
      if (dryRun) {
        return jsonResult(previewConfigChange(config, next));
      }
      const note = await writeConfig(client, next, 'Saved. A Homebridge (or child bridge) restart may be required.');
      return jsonResult({ updated: redactSecrets(updated), note });
    }),
  );
};
