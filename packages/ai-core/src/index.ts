// ── Redaction ──
export {
  PAIRING_KEYS,
  REDACTED,
  SecretRestoreError,
  containsRedacted,
  isSecretKey,
  redactPairing,
  redactSecrets,
  redactText,
  restoreSecrets,
} from './core/redaction.js';

// ── Config ──
export {
  DEFAULT_BASE_URLS,
  DEFAULT_HOMEBRIDGE_URL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MCP_HTTP_HOST,
  DEFAULT_MCP_HTTP_PORT,
  DEFAULT_MODELS,
  EFFORT_LEVELS,
  OPENAI_APIS,
  PLATFORM_NAME,
  PLUGIN_NAME,
  PROVIDER_NAMES,
  defaultConfigPath,
  findAiBlock,
  readAiConfig,
  resolveAiConfig,
} from './core/config.js';
export type { AiConfig, EffortLevel, McpClientConfig, McpHttpConfig, McpScope, OpenAiApi, ProviderName } from './core/config.js';

// ── Providers ──
export {
  AnthropicProvider,
  DEFAULT_RETRY,
  GeminiProvider,
  OpenAiProvider,
  ProviderError,
  backoffDelay,
  complete,
  createProvider,
  isRetryableStatus,
  parseRetryAfter,
} from './providers/index.js';
export type {
  AiProvider,
  AnthropicProviderOptions,
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ContentPart,
  OpenAiProviderOptions,
  ProviderCapabilities,
  ProviderRetryOptions,
  RetryOptions,
  StopReason,
  ToolCall,
  ToolDefinition,
} from './providers/index.js';

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
export type { TrimOptions } from './core/tokens.js';
export { JsonGenerationError, extractJson, generateJson, normalizePluginSchema } from './core/json.js';
export type { GenerateJsonOptions, GenerateJsonResult } from './core/json.js';
export {
  BudgetExceededError,
  MODEL_PRICES,
  UsageTracker,
  ZERO_USAGE,
  addUsage,
  costOf,
  dayKey,
  monthKey,
  priceOf,
  registerModelPrices,
  trackUsage,
} from './core/usage.js';
export type { ModelPrice, TokenUsage, UsageBudget, UsageCounts, UsageSnapshot, UsageStore, UsageSummary, UsageTrackerOptions } from './core/usage.js';
export { JsonFileUsageStore } from './core/usage-store.js';
export { PROMPTS } from './core/prompts.js';
export type { McpPromptName, PromptTemplate } from './core/prompts.js';

// ── Server helpers ──
export { SlidingWindowRateLimiter } from './core/rate-limit.js';
export type { RateLimitResult, RateLimiterOptions } from './core/rate-limit.js';
export { TtlCache } from './core/ttl-cache.js';
export type { TtlCacheOptions } from './core/ttl-cache.js';
export { ConfirmationBroker, withConfirmTimeout } from './core/confirm.js';
export type { ConfirmTimeoutOptions, ConfirmationRequest } from './core/confirm.js';
export { ANSI_PATTERN, readLogTail, stripAnsi, tailLines } from './core/logs.js';
export type { TailOptions } from './core/logs.js';
