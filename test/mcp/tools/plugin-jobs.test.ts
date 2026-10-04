import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB_POLL, register, waitForJob } from '../../../src/mcp/tools/plugin-jobs.js';
import { collectTools, mockClient } from '../helpers.js';

const job = (status: string, output = 'npm output') => ({ id: 'j1', action: 'install', name: 'homebridge-x', status, output, startedAt: 't0' });

afterEach(() => {
  vi.useRealTimers();
});

describe('plugin job tools', () => {
  it('declares write tools as destructive and get_plugin_job as read-only', () => {
    const tools = collectTools(register, mockClient());
    expect([...tools.keys()]).toEqual(['install_plugin', 'update_plugin', 'uninstall_plugin', 'get_plugin_job']);
    expect(tools.get('install_plugin')!.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.get('get_plugin_job')!.config.annotations.readOnlyHint).toBe(true);
  });

  it('installs and waits for the job to finish', async () => {
    vi.useFakeTimers();
    const client = mockClient({
      installPlugin: vi.fn().mockResolvedValue({ jobId: 'j1' }),
      getPluginJob: vi.fn().mockResolvedValueOnce(job('running')).mockResolvedValueOnce(job('succeeded', 'x'.repeat(5000))),
    });
    const pending = collectTools(register, client).get('install_plugin')!.handler({ name: 'homebridge-x', version: '1.2.3' });
    await vi.advanceTimersByTimeAsync(JOB_POLL.intervalMs);
    const result = JSON.parse((await pending).content[0].text);
    expect(client.installPlugin).toHaveBeenCalledWith('homebridge-x', '1.2.3');
    expect(result).toMatchObject({ jobId: 'j1', status: 'succeeded' });
    expect(result.output.length).toBe(4001);
    expect(result.note).toContain('Restart Homebridge');
  });

  it('returns at once with wait=false', async () => {
    const client = mockClient({ updatePlugin: vi.fn().mockResolvedValue({ jobId: 'j1' }), getPluginJob: vi.fn().mockResolvedValue(job('running')) });
    const result = JSON.parse((await collectTools(register, client).get('update_plugin')!.handler({ name: 'homebridge-x', wait: false })).content[0].text);
    expect(result.status).toBe('running');
    expect(result.note).toContain('get_plugin_job');
  });

  it('uninstalls, reports failures and reads a job', async () => {
    const client = mockClient({
      uninstallPlugin: vi.fn().mockResolvedValue({ jobId: 'j1' }),
      getPluginJob: vi.fn().mockResolvedValue({ ...job('failed'), output: undefined }),
    });
    const tools = collectTools(register, client);
    const result = JSON.parse((await tools.get('uninstall_plugin')!.handler({ name: 'homebridge-x' })).content[0].text);
    expect(result).toMatchObject({ status: 'failed', output: '' });
    expect(result.note).toBeUndefined();
    const read = JSON.parse((await tools.get('get_plugin_job')!.handler({ jobId: 'j1' })).content[0].text);
    expect(read.jobId).toBe('j1');
  });

  it('surfaces API errors', async () => {
    const client = mockClient({ installPlugin: vi.fn().mockRejectedValue(new Error('404 not found')) });
    const result = await collectTools(register, client).get('install_plugin')!.handler({ name: 'x' });
    expect(result).toMatchObject({ isError: true, content: [{ text: 'Error installing plugin: 404 not found' }] });
  });

  it('stops waiting at the deadline', async () => {
    vi.useFakeTimers();
    const client = mockClient({ getPluginJob: vi.fn().mockResolvedValue(job('running')) });
    const pending = waitForJob(client, 'j1', 3000);
    await vi.advanceTimersByTimeAsync(4000);
    expect((await pending).status).toBe('running');
    expect(client.getPluginJob).toHaveBeenCalledTimes(3);
  });
});
