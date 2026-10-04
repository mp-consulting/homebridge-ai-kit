/**
 * Ready-made Assistant features. Every input is redacted before it reaches a
 * provider and trimmed to fit the provider's context window.
 */

import { generateJson, normalizePluginSchema } from '../core/json.js';
import { PROMPTS } from '../core/prompts.js';
import { SecretRestoreError, containsRedacted, redactSecrets, redactText, restoreSecrets } from '../core/redaction.js';
import { estimateTokens, inputBudget, trimToContext } from '../core/tokens.js';
import { ZERO_USAGE, addUsage } from '../core/usage.js';
import type { TokenUsage } from '../core/usage.js';
import { complete } from '../providers/index.js';
import type { AiProvider, ChatMessage } from '../providers/types.js';

export interface FeatureOptions {
  provider: AiProvider;
  /** Receives text as it streams (when the provider can stream). */
  onChunk?: (delta: string) => void;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  /** Extra instructions appended to the system prompt, e.g. which plugin this is. */
  systemContext?: string;
}

export interface TextResult {
  text: string;
  usage: TokenUsage;
}

const DEFAULT_OUTPUT = 2048;

function system(base: string, extra?: string): string {
  return extra ? `${base}\n\n${extra}` : base;
}

/** Tokens available for one variable input (logs, changelog…). */
function budget(o: FeatureOptions, cap: number): number {
  return inputBudget(o.provider.capabilities.contextTokens, o.maxOutputTokens ?? DEFAULT_OUTPUT, cap);
}

/** Redact a JSON value and serialise-trim it to `maxTokens`, keeping it valid JSON when it fits. */
function boundedJson(value: unknown, maxTokens: number): unknown {
  const redacted = redactSecrets(value);
  const text = JSON.stringify(redacted);
  return estimateTokens(text) <= maxTokens ? redacted : trimToContext(text, maxTokens, { keep: 'head' });
}

async function text(o: FeatureOptions, base: string, user: string): Promise<TextResult> {
  const result = await complete(
    o.provider,
    { system: system(base, o.systemContext), messages: [{ role: 'user', content: user }], maxOutputTokens: o.maxOutputTokens, signal: o.signal },
    o.onChunk,
  );
  return { text: result.text, usage: result.usage };
}

// ── Log Doctor ─────────────────────────────────────────────────────

export interface DiagnoseLogsOptions extends FeatureOptions {
  logs: string | string[];
  focus?: string;
  /** Cap on log tokens sent (default 24k); older lines are dropped first. */
  maxInputTokens?: number;
}

export function diagnoseLogs(o: DiagnoseLogsOptions): Promise<TextResult> {
  const raw = Array.isArray(o.logs) ? o.logs.join('\n') : o.logs;
  const logs = trimToContext(redactText(raw), budget(o, o.maxInputTokens ?? 24_000));
  return text(o, PROMPTS.diagnoseLogs.system, PROMPTS.diagnoseLogs.user({ logs, focus: o.focus }));
}

// ── Config Copilot ─────────────────────────────────────────────────

export interface GeneratePluginConfigOptions extends FeatureOptions {
  /** The plugin's config.schema.json (the whole file or just its `schema`). */
  schema: Record<string, unknown>;
  /** What the user wants, in natural language. */
  request: string;
  /** The current config block, if editing. Secrets are redacted before sending and restored after. */
  current?: Record<string, unknown>;
  pluginName?: string;
}

export interface PluginConfigResult {
  config: Record<string, unknown>;
  explanation: string;
  usage: TokenUsage;
}

export async function generatePluginConfig(o: GeneratePluginConfigOptions): Promise<PluginConfigResult> {
  const pluginSchema = (o.schema.schema as Record<string, unknown> | undefined) ?? o.schema;
  const configSchema = normalizePluginSchema(pluginSchema) as Record<string, unknown>;
  const schema = {
    type: 'object',
    required: ['config', 'explanation'],
    properties: { config: { ...configSchema, type: 'object' }, explanation: { type: 'string' } },
  };
  const current = o.current === undefined ? undefined : redactSecrets(o.current);
  const { data, usage } = await generateJson<{ config: Record<string, unknown>; explanation: string }>({
    provider: o.provider,
    schema,
    system: system(PROMPTS.generatePluginConfig.system, o.systemContext),
    prompt: PROMPTS.generatePluginConfig.user({ request: redactText(o.request), schema: pluginSchema, current, pluginName: o.pluginName }),
    maxOutputTokens: o.maxOutputTokens,
    signal: o.signal,
    onChunk: o.onChunk,
  });
  let config = data.config;
  if (o.current !== undefined && containsRedacted(config)) {
    try {
      config = restoreSecrets(config, o.current) as Record<string, unknown>;
    } catch (error) {
      // A new secret field with no current value: leave the placeholder for the user to fill in.
      if (!(error instanceof SecretRestoreError)) {
        throw error;
      }
    }
  }
  return { config, explanation: data.explanation, usage };
}

// ── Device errors ──────────────────────────────────────────────────

export interface ExplainDeviceErrorOptions extends FeatureOptions {
  error: string;
  context?: string;
  device?: unknown;
  pluginName?: string;
}

export function explainDeviceError(o: ExplainDeviceErrorOptions): Promise<TextResult> {
  const cap = budget(o, 8_000);
  return text(
    o,
    PROMPTS.explainDeviceError.system,
    PROMPTS.explainDeviceError.user({
      error: trimToContext(redactText(o.error), cap / 2),
      context: o.context === undefined ? undefined : trimToContext(redactText(o.context), cap / 4),
      device: o.device === undefined ? undefined : boundedJson(o.device, cap / 4),
      pluginName: o.pluginName,
    }),
  );
}

// ── Update risk ────────────────────────────────────────────────────

export interface AssessPluginUpdateOptions extends FeatureOptions {
  pluginName: string;
  currentVersion: string;
  targetVersion: string;
  changelog: string;
}

export interface UpdateRisk {
  risk: 'low' | 'medium' | 'high';
  summary: string;
  breakingChanges: string[];
  usage: TokenUsage;
}

const UPDATE_RISK_SCHEMA = {
  type: 'object',
  required: ['risk', 'summary', 'breakingChanges'],
  properties: {
    risk: { enum: ['low', 'medium', 'high'] },
    summary: { type: 'string' },
    breakingChanges: { type: 'array', items: { type: 'string' } },
  },
};

export async function assessPluginUpdate(o: AssessPluginUpdateOptions): Promise<UpdateRisk> {
  const { data, usage } = await generateJson<Omit<UpdateRisk, 'usage'>>({
    provider: o.provider,
    schema: UPDATE_RISK_SCHEMA,
    system: system(PROMPTS.assessPluginUpdate.system, o.systemContext),
    prompt: PROMPTS.assessPluginUpdate.user({
      pluginName: o.pluginName,
      currentVersion: o.currentVersion,
      targetVersion: o.targetVersion,
      // Changelogs put the newest release first.
      changelog: trimToContext(redactText(o.changelog), budget(o, 16_000), { keep: 'head' }),
    }),
    maxOutputTokens: o.maxOutputTokens,
    signal: o.signal,
    onChunk: o.onChunk,
  });
  return { risk: data.risk, summary: data.summary, breakingChanges: data.breakingChanges, usage };
}

// ── Organiser ──────────────────────────────────────────────────────

export interface SuggestOrganizationOptions extends FeatureOptions {
  /** Accessories, e.g. from `list_accessories` (uniqueId, serviceName, type, manufacturer…). */
  accessories: unknown[];
  /** Current room layout, if any. */
  rooms?: unknown;
}

export interface OrganizationSuggestion {
  rooms: Array<{ name: string; accessories: string[] }>;
  renames: Array<{ uniqueId: string; name: string; reason?: string }>;
  orphans: Array<{ uniqueId: string; reason: string }>;
  usage: TokenUsage;
}

const ORGANIZATION_SCHEMA = {
  type: 'object',
  required: ['rooms', 'renames', 'orphans'],
  properties: {
    rooms: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'accessories'],
        properties: { name: { type: 'string' }, accessories: { type: 'array', items: { type: 'string' } } },
      },
    },
    renames: {
      type: 'array',
      items: {
        type: 'object',
        required: ['uniqueId', 'name'],
        properties: { uniqueId: { type: 'string' }, name: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    orphans: {
      type: 'array',
      items: { type: 'object', required: ['uniqueId', 'reason'], properties: { uniqueId: { type: 'string' }, reason: { type: 'string' } } },
    },
  },
};

/** Output tokens one accessory can take in the reply (room entry, rename with a short reason). */
const TOKENS_PER_ACCESSORY = 60;

/**
 * Accessories per request, so each reply fits the output limit. A large
 * installation in one request ran past `maxOutputTokens`, and the cut-off JSON
 * failed validation.
 */
function organizationBatchSize(maxOutputTokens: number | undefined): number {
  return Math.max(5, Math.floor(((maxOutputTokens ?? DEFAULT_OUTPUT) * 0.75) / TOKENS_PER_ACCESSORY));
}

export async function suggestOrganization(o: SuggestOrganizationOptions): Promise<OrganizationSuggestion> {
  const cap = budget(o, 32_000);
  // HomeKit uniqueIds are long hashes: send short aliases instead (fewer tokens
  // in the reply, nothing to mistype) and map them back afterwards.
  const toId = new Map<string, string>();
  const items = o.accessories.map((a) => {
    const id = typeof a === 'object' && a !== null ? (a as { uniqueId?: unknown }).uniqueId : undefined;
    if (typeof id !== 'string') {
      return a;
    }
    const alias = `a${toId.size + 1}`;
    toId.set(alias, id);
    return { ...(a as object), uniqueId: alias };
  });
  // With ids, only aliases we handed out count; without any, keep what the model says.
  const resolve = (alias: string): string | undefined => (toId.size === 0 ? alias : toId.get(alias));

  const rooms = new Map<string, string[]>();
  const renames: OrganizationSuggestion['renames'] = [];
  const orphans: OrganizationSuggestion['orphans'] = [];
  let usage: TokenUsage = ZERO_USAGE;
  const size = organizationBatchSize(o.maxOutputTokens);

  for (let i = 0; i < items.length || i === 0; i += size) {
    const { data, usage: used } = await generateJson<Omit<OrganizationSuggestion, 'usage'>>({
      provider: o.provider,
      schema: ORGANIZATION_SCHEMA,
      system: system(PROMPTS.suggestOrganization.system, o.systemContext),
      prompt: PROMPTS.suggestOrganization.user({
        accessories: boundedJson(items.slice(i, i + size), (cap * 3) / 4),
        rooms: o.rooms === undefined ? undefined : boundedJson(o.rooms, cap / 4),
      }),
      maxOutputTokens: o.maxOutputTokens,
      signal: o.signal,
      onChunk: o.onChunk,
    });
    usage = addUsage(usage, used);
    for (const room of data.rooms) {
      const ids = room.accessories.map(resolve).filter((id): id is string => id !== undefined);
      rooms.set(room.name, [...(rooms.get(room.name) ?? []), ...ids]);
    }
    for (const rename of data.renames) {
      const uniqueId = resolve(rename.uniqueId);
      if (uniqueId !== undefined) {
        renames.push({ ...rename, uniqueId });
      }
    }
    for (const orphan of data.orphans) {
      const uniqueId = resolve(orphan.uniqueId);
      if (uniqueId !== undefined) {
        orphans.push({ ...orphan, uniqueId });
      }
    }
  }

  return {
    rooms: [...rooms].map(([name, accessories]) => ({ name, accessories })),
    renames,
    orphans,
    usage,
  };
}

// ── Daily digest ───────────────────────────────────────────────────

export interface DailyDigestOptions extends FeatureOptions {
  /** e.g. `get_homebridge_status` / `get_server_status` output. */
  status?: unknown;
  /** Recent warning and error lines. */
  logs?: string | string[];
  /** Plugins with updates available. */
  updates?: unknown;
  accessories?: unknown;
  /** Defaults to today (ISO date). */
  date?: string;
}

export function dailyDigest(o: DailyDigestOptions): Promise<TextResult> {
  const cap = budget(o, 16_000);
  const logs = o.logs === undefined ? undefined : trimToContext(redactText(Array.isArray(o.logs) ? o.logs.join('\n') : o.logs), cap / 2);
  return text(
    o,
    PROMPTS.dailyDigest.system,
    PROMPTS.dailyDigest.user({
      date: o.date ?? new Date().toISOString().slice(0, 10),
      status: o.status === undefined ? undefined : boundedJson(o.status, cap / 8),
      updates: o.updates === undefined ? undefined : boundedJson(o.updates, cap / 8),
      accessories: o.accessories === undefined ? undefined : boundedJson(o.accessories, cap / 4),
      logs,
    }),
  );
}

// ── Free-form question ─────────────────────────────────────────────

export interface AskOptions extends FeatureOptions {
  prompt: string;
  context?: string;
  /** Earlier turns of the conversation. */
  history?: ChatMessage[];
}

export async function ask(o: AskOptions): Promise<TextResult> {
  const cap = budget(o, 16_000);
  const user = PROMPTS.ask.user({
    prompt: redactText(o.prompt),
    context: o.context === undefined ? undefined : trimToContext(redactText(o.context), cap),
  });
  const result = await complete(
    o.provider,
    {
      system: system(PROMPTS.ask.system, o.systemContext),
      messages: [...(o.history ?? []), { role: 'user', content: user }],
      maxOutputTokens: o.maxOutputTokens,
      signal: o.signal,
    },
    o.onChunk,
  );
  return { text: result.text, usage: result.usage };
}

