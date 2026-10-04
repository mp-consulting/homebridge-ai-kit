import { PLATFORM_NAME } from './core/config.js';
import { AiKitPlatform } from './plugin/platform.js';

// ── Redaction ──
export { REDACTED, SecretRestoreError, containsRedacted, isSecretKey, redactSecrets, redactText, restoreSecrets } from './core/redaction.js';

// ── Config ──
export {
  DEFAULT_MODELS,
  PLATFORM_NAME,
  PLUGIN_NAME,
  PROVIDER_NAMES,
  defaultConfigPath,
  findAiBlock,
  readAiConfig,
  resolveAiConfig,
} from './core/config.js';
export type { AiConfig, McpHttpConfig, ProviderName } from './core/config.js';

// ── Providers ──
export { AnthropicProvider, GeminiProvider, OpenAiProvider, ProviderError, complete, createProvider } from './providers/index.js';
export type {
  AiProvider,
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ContentPart,
  ProviderCapabilities,
  StopReason,
  ToolCall,
  ToolDefinition,
} from './providers/index.js';

// ── Agent ──
export { runAgent } from './agent/run-agent.js';
export type { AgentEvent, AgentResult, AgentToolCall, RunAgentOptions } from './agent/run-agent.js';

// ── Features ──
export { ask, assessPluginUpdate, dailyDigest, diagnoseLogs, explainDeviceError, generatePluginConfig, suggestOrganization } from './features/index.js';
export type {
  AskOptions,
  AssessPluginUpdateOptions,
  DailyDigestOptions,
  DiagnoseLogsOptions,
  ExplainDeviceErrorOptions,
  FeatureOptions,
  GeneratePluginConfigOptions,
  OrganizationSuggestion,
  PluginConfigResult,
  SuggestOrganizationOptions,
  TextResult,
  UpdateRisk,
} from './features/index.js';

// ── Utilities ──
export { estimateTokens, inputBudget, trimToContext } from './core/tokens.js';
export { JsonGenerationError, extractJson, generateJson, normalizePluginSchema } from './core/json.js';
export type { GenerateJsonOptions, GenerateJsonResult } from './core/json.js';
export { MODEL_PRICES, UsageTracker, costOf } from './core/usage.js';
export type { TokenUsage, UsageSummary } from './core/usage.js';
export { PROMPTS } from './core/prompts.js';

/** Homebridge plugin entry point. */
export default (api: { registerPlatform(name: string, constructor: unknown): void }): void => {
  api.registerPlatform(PLATFORM_NAME, AiKitPlatform);
};
