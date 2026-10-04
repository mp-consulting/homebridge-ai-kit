import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { redactSecrets } from '@mp-consulting/homebridge-ai-core';
import type { HomebridgeClient } from '../homebridge-client.js';
import { requireGlassUi } from '../homebridge-client.js';
import type { RegisterTools } from '../types.js';
import { diffJson, unifiedJsonDiff } from '../config-diff.js';
import { READ, errorResult, handle, jsonResult, textResult } from './helpers.js';

/** Path-level changes listed in a dry run; the unified diff always shows everything. */
export const MAX_LISTED_CHANGES = 100;

type Config = Record<string, unknown>;

/**
 * The backup the UI made of the previous config.json during the save that just
 * happened: both Homebridge UIs copy the file before every POST /api/config-editor,
 * so that is the snapshot `restore_config` rolls back to. Undefined when the UI
 * can't list its backups.
 */
export async function latestConfigBackupId(client: HomebridgeClient): Promise<string | undefined> {
  try {
    const backups = await client.listConfigBackups();
    if (!Array.isArray(backups) || backups.length === 0) {
      return undefined;
    }
    return backups.reduce((newest, b) => (Number(b.id) > Number(newest.id) ? b : newest)).id;
  } catch {
    return undefined;
  }
}

/** What writing `next` over `current` would change, with secrets redacted on both sides. */
export function previewConfigChange(current: Config, next: Config) {
  const before = redactSecrets(current);
  const after = redactSecrets(next);
  const changes = diffJson(before, after);
  return {
    dryRun: true,
    changed: changes.length,
    changes: changes.slice(0, MAX_LISTED_CHANGES),
    ...(changes.length > MAX_LISTED_CHANGES ? { changesTruncated: true } : {}),
    diff: unifiedJsonDiff(before, after),
    note: changes.length ? 'Nothing was written. Call again without dryRun to save.' : 'No changes: the config is already like this.',
  };
}

/** Saves `next` and returns a message naming the backup that undoes it. */
export async function writeConfig(client: HomebridgeClient, next: Config, done: string): Promise<string> {
  await client.updateConfig(next);
  const backupId = await latestConfigBackupId(client);
  const undo = backupId
    ? ` The previous config.json was saved as backup ${backupId}; restore_config with backupId "${backupId}" undoes this.`
    : '';
  return `${done}${undo}`;
}

function summarizeInstanceBackup(b: Record<string, unknown>) {
  return { id: b.id, timestamp: b.timestamp, fileName: b.fileName, sizeMB: b.size === undefined ? undefined : Number(b.size) };
}

export const register: RegisterTools = (tool, client) => {
  tool(
    'list_config_backups',
    {
      title: 'List config.json backups',
      description:
        'List the config.json backups the Homebridge UI keeps (it saves one before every config change, for 60 days), newest first. ' +
        'Pass an id to restore_config to roll back.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe('How many backups to return, newest first (default 20).'),
      },
      annotations: READ,
    },
    handle('listing config backups', async ({ limit }) => {
      const backups = [...(await client.listConfigBackups())].sort((a, b) => Number(b.id) - Number(a.id));
      return jsonResult({
        total: backups.length,
        backups: backups.slice(0, limit ?? 20).map((b) => ({ id: String(b.id), timestamp: b.timestamp })),
      });
    }),
  );

  tool(
    'restore_config',
    {
      title: 'Restore config.json backup',
      description:
        'Replace config.json with one of its backups (from list_config_backups). The current file is backed up first, so a restore can itself be undone. ' +
        'Pass dryRun=true to see the redacted diff without writing. A Homebridge restart is needed for the restored config to take effect.',
      inputSchema: {
        backupId: z.string().regex(/^\d{1,16}$/, 'must be a backup id from list_config_backups').describe('The backup id'),
        dryRun: z.boolean().optional().describe('Only show what would change (redacted diff); write nothing.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handle('restoring config', async ({ backupId, dryRun }): Promise<CallToolResult> => {
      const backup = await client.getConfigBackup(backupId);
      if (typeof backup.bridge !== 'object' || backup.bridge === null) {
        return errorResult(`Backup ${backupId} has no bridge block; refusing to restore it.`);
      }
      if (dryRun) {
        return jsonResult({ backupId, ...previewConfigChange(await client.getConfig(), backup) });
      }
      return textResult(await writeConfig(client, backup, `Restored config.json from backup ${backupId}. Restart Homebridge to apply it.`));
    }),
  );

  tool(
    'create_backup',
    {
      title: 'Create instance backup',
      description:
        'Create a full Homebridge backup (config, accessories cache, plugin storage) in the Homebridge UI backup directory, ' +
        'e.g. before a risky change. It appears in list_backups and can be downloaded or restored from the Homebridge UI.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handle('creating backup', async () => {
      await requireGlassUi('Creating a backup from the MCP server', () => client.createInstanceBackup());
      const [newest] = await client.listInstanceBackups().catch(() => []);
      return jsonResult({ created: true, ...(newest ? { backup: summarizeInstanceBackup(newest) } : {}) });
    }),
  );

  tool(
    'list_backups',
    {
      title: 'List instance backups',
      description: 'List the full Homebridge backups (.tar.gz) in the Homebridge UI backup directory, made by the nightly schedule or create_backup, newest first.',
      annotations: READ,
    },
    handle('listing backups', async () =>
      jsonResult((await requireGlassUi('Listing backups', () => client.listInstanceBackups())).map(summarizeInstanceBackup)),
    ),
  );
};
