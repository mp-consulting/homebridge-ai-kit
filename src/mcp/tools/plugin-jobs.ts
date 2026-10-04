import { z } from 'zod';
import type { HomebridgeClient } from '../homebridge-client.js';
import type { PluginJob, RegisterTools } from '../types.js';
import { READ, handle, jsonResult } from './helpers.js';

/** How often a running job is polled, and for how long a tool call waits for it. */
export const JOB_POLL = { intervalMs: 2000, maxWaitMs: 120_000 };

/** Keep the end of the npm output; that is where success or the error is. */
const OUTPUT_TAIL = 4000;

function summarize(job: PluginJob) {
  const output = job.output ?? '';
  return {
    jobId: job.id,
    action: job.action,
    name: job.name,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    output: output.length > OUTPUT_TAIL ? `…${output.slice(-OUTPUT_TAIL)}` : output,
  };
}

/** Poll a job until it finishes or `maxWaitMs` passes, whichever comes first. */
export async function waitForJob(client: HomebridgeClient, jobId: string, maxWaitMs = JOB_POLL.maxWaitMs): Promise<PluginJob> {
  const deadline = Date.now() + maxWaitMs;
  let job = await client.getPluginJob(jobId);
  while (job.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL.intervalMs));
    job = await client.getPluginJob(jobId);
  }
  return job;
}

const name = z
  .string()
  .min(1)
  .regex(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/, 'must be an npm package name')
  .describe("The npm package name, e.g. 'homebridge-hue' or '@scope/homebridge-plugin'");
const version = z.string().min(1).optional().describe("Version or dist-tag to install (default 'latest')");
const wait = z
  .boolean()
  .optional()
  .describe(`Wait for the job to finish (up to ${JOB_POLL.maxWaitMs / 1000}s). Default true; otherwise poll with get_plugin_job.`);

const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export const register: RegisterTools = (tool, client) => {
  const run = async (start: Promise<{ jobId: string }>, shouldWait: boolean | undefined) => {
    const { jobId } = await start;
    const job = shouldWait === false ? await client.getPluginJob(jobId) : await waitForJob(client, jobId);
    return jsonResult({
      ...summarize(job),
      ...(job.status === 'running' ? { note: 'Still running; call get_plugin_job with this jobId to follow it.' } : {}),
      ...(job.status === 'succeeded' ? { note: 'Restart Homebridge (or the plugin\'s child bridge) to load the change.' } : {}),
    });
  };

  tool(
    'install_plugin',
    {
      title: 'Install plugin',
      description: 'Install a Homebridge plugin from npm. Runs as a background job on the Homebridge UI; returns the job status and npm output.',
      inputSchema: { name, version, wait },
      annotations: WRITE,
    },
    handle('installing plugin', async ({ name, version, wait }) => run(client.installPlugin(name, version), wait)),
  );

  tool(
    'update_plugin',
    {
      title: 'Update plugin',
      description: 'Update an installed Homebridge plugin to the latest (or a given) version. Check get_plugin_changelog for breaking changes first.',
      inputSchema: { name, version, wait },
      annotations: WRITE,
    },
    handle('updating plugin', async ({ name, version, wait }) => run(client.updatePlugin(name, version), wait)),
  );

  tool(
    'uninstall_plugin',
    {
      title: 'Uninstall plugin',
      description: 'Uninstall a Homebridge plugin. Its config.json blocks are left in place.',
      inputSchema: { name, wait },
      annotations: WRITE,
    },
    handle('uninstalling plugin', async ({ name, wait }) => run(client.uninstallPlugin(name), wait)),
  );

  tool(
    'get_plugin_job',
    {
      title: 'Plugin job status',
      description: 'Get the status and npm output of a plugin install, update or uninstall job.',
      inputSchema: { jobId: z.string().min(1).describe('The jobId returned by install_plugin, update_plugin or uninstall_plugin') },
      annotations: READ,
    },
    handle('getting plugin job', async ({ jobId }) => jsonResult(summarize(await client.getPluginJob(jobId)))),
  );
};
