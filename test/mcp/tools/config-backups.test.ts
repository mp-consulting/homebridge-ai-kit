import { describe, expect, it, vi } from 'vitest';
import { register } from '../../../src/mcp/tools/config-backups.js';
import { HomebridgeApiError } from '../../../src/mcp/homebridge-client.js';
import { collectHandlers, mockClient } from '../helpers.js';

const current = { bridge: { name: 'HB', pin: '111-11-111' }, platforms: [{ platform: 'Hue', apiKey: 'live-key' }] };
const backup = { bridge: { name: 'Old', pin: '111-11-111' }, platforms: [{ platform: 'Hue', apiKey: 'old-key' }] };
const missing = (method: string, path: string) => new HomebridgeApiError(404, method, path, `{"message":"Cannot ${method} ${path}","statusCode":404}`);

function setup(overrides: Parameters<typeof mockClient>[0] = {}) {
  const client = mockClient({
    getConfig: vi.fn().mockResolvedValue(structuredClone(current)),
    getConfigBackup: vi.fn().mockResolvedValue(structuredClone(backup)),
    updateConfig: vi.fn().mockResolvedValue(current),
    listConfigBackups: vi.fn().mockResolvedValue([
      { id: '100', timestamp: '1970-01-01T00:00:00.100Z' },
      { id: '300', timestamp: '1970-01-01T00:00:00.300Z' },
      { id: '200', timestamp: '1970-01-01T00:00:00.200Z' },
    ]),
    ...overrides,
  });
  return { client, tools: collectHandlers(register, client) };
}

describe('config backup tools', () => {
  it('lists config backups newest first with a limit', async () => {
    const { tools } = setup();
    const result = JSON.parse((await tools.get('list_config_backups')!({ limit: 2 })).content[0].text);
    expect(result).toEqual({
      total: 3,
      backups: [
        { id: '300', timestamp: '1970-01-01T00:00:00.300Z' },
        { id: '200', timestamp: '1970-01-01T00:00:00.200Z' },
      ],
    });
  });

  it('previews a restore without writing or leaking secrets', async () => {
    const { client, tools } = setup();
    const result = await tools.get('restore_config')!({ backupId: '200', dryRun: true });
    const preview = JSON.parse(result.content[0].text);
    expect(client.getConfigBackup).toHaveBeenCalledWith('200');
    expect(client.updateConfig).not.toHaveBeenCalled();
    expect(preview.backupId).toBe('200');
    expect(preview.changes).toEqual([{ path: 'bridge.name', op: 'change', before: 'HB', after: 'Old' }]);
    expect(result.content[0].text).not.toMatch(/live-key|old-key|111-11-111/);
  });

  it('restores a backup and names the snapshot of the replaced file', async () => {
    const { client, tools } = setup();
    const result = await tools.get('restore_config')!({ backupId: '200' });
    expect(client.updateConfig).toHaveBeenCalledWith(backup);
    expect(result.content[0].text).toContain('Restored config.json from backup 200');
    expect(result.content[0].text).toContain('backupId "300"');
  });

  it('refuses a backup without a bridge block', async () => {
    const { client, tools } = setup({ getConfigBackup: vi.fn().mockResolvedValue({ platforms: [] }) });
    const result = await tools.get('restore_config')!({ backupId: '200' });
    expect(result.isError).toBe(true);
    expect(client.updateConfig).not.toHaveBeenCalled();
  });

  it('still reports the write when the backups cannot be listed', async () => {
    const { tools } = setup({ listConfigBackups: vi.fn().mockRejectedValue(new Error('nope')) });
    const result = await tools.get('restore_config')!({ backupId: '200' });
    expect(result.content[0].text).toBe('Restored config.json from backup 200. Restart Homebridge to apply it.');
  });

  it('lists the change paths only up to the cap', async () => {
    const big = { bridge: {}, platforms: Array.from({ length: 150 }, (_, i) => ({ platform: `P${i}` })) };
    const { tools } = setup({ getConfigBackup: vi.fn().mockResolvedValue(big), getConfig: vi.fn().mockResolvedValue({ bridge: {}, platforms: [] }) });
    const preview = JSON.parse((await tools.get('restore_config')!({ backupId: '1', dryRun: true })).content[0].text);
    expect(preview.changed).toBe(150);
    expect(preview.changes).toHaveLength(100);
    expect(preview.changesTruncated).toBe(true);
  });

  it('creates an instance backup and returns the newest one', async () => {
    const { client, tools } = setup({
      createInstanceBackup: vi.fn().mockResolvedValue(''),
      listInstanceBackups: vi.fn().mockResolvedValue([{ id: 'abc.1', timestamp: 't', fileName: 'f.tar.gz', size: '12.5', instanceId: 'abc' }]),
    });
    const result = JSON.parse((await tools.get('create_backup')!({})).content[0].text);
    expect(client.createInstanceBackup).toHaveBeenCalled();
    expect(result).toEqual({ created: true, backup: { id: 'abc.1', timestamp: 't', fileName: 'f.tar.gz', sizeMB: 12.5 } });
  });

  it('creates a backup even when the list fails', async () => {
    const { tools } = setup({ createInstanceBackup: vi.fn().mockResolvedValue(''), listInstanceBackups: vi.fn().mockRejectedValue(new Error('x')) });
    expect(JSON.parse((await tools.get('create_backup')!({})).content[0].text)).toEqual({ created: true });
  });

  it('says when the UI has no backup endpoint', async () => {
    const { tools } = setup({ createInstanceBackup: vi.fn().mockRejectedValue(missing('POST', '/api/backup')) });
    const result = await tools.get('create_backup')!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires Homebridge Glass UI');
  });

  it('lists instance backups', async () => {
    const { tools } = setup({ listInstanceBackups: vi.fn().mockResolvedValue([{ id: 'a.1', timestamp: 't' }]) });
    expect(JSON.parse((await tools.get('list_backups')!({})).content[0].text)).toEqual([{ id: 'a.1', timestamp: 't' }]);
  });

  it('passes other errors through', async () => {
    const { tools } = setup({ listInstanceBackups: vi.fn().mockRejectedValue(new HomebridgeApiError(403, 'GET', '/x', 'Forbidden')) });
    const result = await tools.get('list_backups')!({});
    expect(result.content[0].text).toBe('Error listing backups: Homebridge API error 403 GET /x: Forbidden');
  });
});
