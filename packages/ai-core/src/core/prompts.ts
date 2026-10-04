/**
 * Prompt templates shared by the AI features and the MCP prompts, so the
 * built-in Assistant and outside clients (Claude Desktop, Cursor) ask the
 * same questions the same way.
 */

const BASE = [
  'You are the Assistant built into Homebridge, the open-source bridge that brings non-HomeKit smart-home devices to Apple Home.',
  'Be accurate and concise. Use plain language a home user understands, and Markdown for structure.',
  'Never invent configuration keys, plugin names or versions; say when you are unsure.',
  'Values shown as "__REDACTED__" are secrets that were hidden on purpose; never ask for them and keep the placeholder as-is.',
].join(' ');

export interface PromptTemplate<I> {
  system: string;
  user: (input: I) => string;
}

function section(title: string, body: string | undefined): string {
  return body ? `\n\n## ${title}\n${body}` : '';
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

interface UpdateInput {
  pluginName: string;
  currentVersion: string;
  targetVersion: string;
  changelog: string;
}

export const PROMPTS = {
  base: BASE,

  diagnoseLogs: {
    system:
      `${BASE} You diagnose Homebridge logs. Group related errors, name the plugin each one comes from, ` +
      'explain the likely cause and give concrete fixes. Ignore routine info lines. If nothing is wrong, say so.',
    user: ({ logs, focus }: { logs: string; focus?: string }) =>
      `Diagnose these Homebridge log lines.${focus ? ` Focus on: ${focus}.` : ''}` +
      '\n\nAnswer with: **Summary** (one or two sentences), then **Issues** (each with plugin, cause and fix), most severe first.' +
      section('Logs', `\`\`\`\n${logs}\n\`\`\``),
  } satisfies PromptTemplate<{ logs: string; focus?: string }>,

  generatePluginConfig: {
    system: `${BASE} You write Homebridge plugin configuration blocks that follow the plugin's JSON schema exactly. Only use keys defined by the schema.`,
    user: ({ request, schema, current, pluginName }: { request: string; schema: unknown; current?: unknown; pluginName?: string }) =>
      `Write the configuration${pluginName ? ` for the Homebridge plugin ${pluginName}` : ''} that does this: ${request}` +
      '\n\nReply with a JSON object {"config": <the complete config block>, "explanation": "<what you set and why, in a few sentences>"}.' +
      (current ? ' Start from the current config and change only what the request needs.' : '') +
      section('Config schema', json(schema)) +
      section('Current config', current === undefined ? undefined : json(current)),
  } satisfies PromptTemplate<{ request: string; schema: unknown; current?: unknown; pluginName?: string }>,

  explainDeviceError: {
    system:
      `${BASE} You explain smart-home device errors to the person who owns the device. ` +
      'Say what the error means, the most likely causes, and the steps to fix it, in order.',
    user: ({ error, context, device, pluginName }: { error: string; context?: string; device?: unknown; pluginName?: string }) =>
      `Explain this error${pluginName ? ` from the Homebridge plugin ${pluginName}` : ''} and how to fix it.` +
      section('Error', `\`\`\`\n${error}\n\`\`\``) +
      section('Device', device === undefined ? undefined : json(device)) +
      section('Context', context),
  } satisfies PromptTemplate<{ error: string; context?: string; device?: unknown; pluginName?: string }>,

  assessPluginUpdate: {
    system:
      `${BASE} You assess the risk of updating a Homebridge plugin from its changelog. ` +
      'Breaking changes, config changes, raised Node.js or Homebridge requirements and removed features raise the risk.',
    user: ({ pluginName, currentVersion, targetVersion, changelog }: UpdateInput) =>
      `Assess updating ${pluginName} from ${currentVersion} to ${targetVersion}.` +
      '\n\nReply with a JSON object {"risk": "low" | "medium" | "high", "summary": "<two or three sentences>", "breakingChanges": ["<each change the user must act on>"]}.' +
      section('Changelog', changelog),
  } satisfies PromptTemplate<UpdateInput>,

  suggestOrganization: {
    system: `${BASE} You organise Homebridge accessories into rooms and give them clear names. Only use the uniqueId values you are given.`,
    user: ({ accessories, rooms }: { accessories: unknown; rooms?: unknown }) =>
      'Suggest rooms and clearer names for these accessories, and list orphans (accessories that look stale, duplicated or unassignable). ' +
      'Only list renames that improve a name, and keep every reason under ten words.' +
      '\n\nReply with a JSON object {"rooms": [{"name": "...", "accessories": ["<uniqueId>"]}], ' +
      '"renames": [{"uniqueId": "...", "name": "...", "reason": "..."}], "orphans": [{"uniqueId": "...", "reason": "..."}]}.' +
      section('Accessories', json(accessories)) +
      section('Current rooms', rooms === undefined ? undefined : json(rooms)),
  } satisfies PromptTemplate<{ accessories: unknown; rooms?: unknown }>,

  dailyDigest: {
    system: `${BASE} You write a short daily digest of a Homebridge installation: what needs attention first, then what is fine. Keep it under 200 words.`,
    user: ({ date, status, logs, updates, accessories }: { date: string; status?: unknown; logs?: string; updates?: unknown; accessories?: unknown }) =>
      `Write the Homebridge digest for ${date}.` +
      section('Status', status === undefined ? undefined : json(status)) +
      section('Available updates', updates === undefined ? undefined : json(updates)) +
      section('Accessories', accessories === undefined ? undefined : json(accessories)) +
      section('Warnings and errors from the log', logs ? `\`\`\`\n${logs}\n\`\`\`` : undefined),
  } satisfies PromptTemplate<{ date: string; status?: unknown; logs?: string; updates?: unknown; accessories?: unknown }>,

  ask: {
    system: `${BASE} Answer questions about Homebridge, its plugins and the user's setup.`,
    user: ({ prompt, context }: { prompt: string; context?: string }) => prompt + section('Context', context),
  } satisfies PromptTemplate<{ prompt: string; context?: string }>,

  /** Asks the model to fix JSON that failed schema validation. */
  repairJson: (errors: string) =>
    `That reply was not valid. Problems: ${errors}\nReply again with only the corrected JSON, no prose and no code fences.`,

  /** Texts of the MCP prompts (`prompts/list`), which run against the MCP tools. */
  mcp: {
    'diagnose-logs': {
      title: 'Diagnose Homebridge logs',
      description: 'Read the recent Homebridge log, find errors and warnings, and explain the causes and fixes.',
      text: ({ focus }: { focus?: string }) =>
        'Use get_recent_logs (and search_logs for anything that needs more history) to read the Homebridge log. ' +
        'Group related errors and warnings, name the plugin behind each one, explain the likely cause and give concrete fixes, most severe first. ' +
        'Use get_plugin_config_schema or get_config when a fix involves configuration.' +
        (focus ? ` Focus on: ${focus}.` : ''),
    },
    'plan-upgrade': {
      title: 'Plan plugin upgrades',
      description: 'Check installed plugins for updates and rate the risk of each from its changelog.',
      text: ({ plugin }: { plugin?: string }) =>
        (plugin ? `Plan the upgrade of the Homebridge plugin ${plugin}. ` : 'Plan upgrades for the installed Homebridge plugins that have updates. ') +
        'Use list_plugins to find installed and latest versions, and get_plugin_changelog for each candidate. ' +
        'For each plugin rate the risk low, medium or high, list breaking changes and config changes the user must make, and suggest an order. ' +
        'Do not install anything; only plan.',
    },
    'audit-config': {
      title: 'Audit config.json',
      description: 'Review config.json for mistakes, deprecated options, duplicates and security issues.',
      text: () =>
        'Use get_config to read config.json, list_plugins to see what is installed and get_plugin_config_schema to check each platform and accessory block. ' +
        'Report: blocks for plugins that are not installed, keys the schema does not define, duplicate names or ports, ' +
        'child bridges that collide, and security concerns (e.g. a default pin). Suggest fixes; do not change the config unless asked.',
    },
  },
} as const;

export type McpPromptName = keyof typeof PROMPTS.mcp;
