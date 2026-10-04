# Changelog

All notable changes to `@mp-consulting/homebridge-ai-core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Provider requests are retried.** Network errors and HTTP 408, 429, 5xx (including Anthropic's 529 "overloaded") are retried with full-jitter exponential backoff (500 ms base, 8 s cap), waiting at least as long as a `retry-after` / `retry-after-ms` header asks; a `retry-after` over 60 s fails at once instead of hanging. An aborted signal stops at once, also mid-backoff. Streaming requests are retried until the response starts. The `HomebridgeAiKit` block takes `maxRetries` (default 2, 0 turns it off); the provider constructors also take `maxRetries` and a `retry` object (`baseDelayMs`, `maxDelayMs`, `maxRetryAfterMs`). New exports: `DEFAULT_RETRY`, `isRetryableStatus`, `parseRetryAfter`, `backoffDelay` and the types `RetryOptions`, `ProviderRetryOptions`.
- **Claude prompt caching.** The Anthropic adapter puts a cache breakpoint on the last tool definition and on the system prompt, and turns on top-level automatic caching for the conversation, so each step of an agent loop reads the tools, system prompt and earlier turns from the cache instead of paying for them again. `new AnthropicProvider({ …, promptCaching: false })` turns it off (for proxies that reject `cache_control`).
- **Claude `effort`.** The `HomebridgeAiKit` block takes `effort` (`low` | `medium` | `high` | `xhigh` | `max`), sent as `output_config.effort`; unset keeps the model's default. `ChatRequest.effort` overrides it per call. New exports: `EFFORT_LEVELS`, `EffortLevel`, `AnthropicProviderOptions`.
- `TokenUsage` has optional `cacheReadTokens` / `cacheWriteTokens` (parts of `inputTokens`), `ModelPrice` has optional `cacheRead` / `cacheWrite` rates, and `priceOf(model)` looks a price up (also without a date suffix or `models/` prefix).

### Fixed

- **Claude costs with prompt caching were wrong.** Cache reads and writes were counted as ordinary input. `costOf` now prices them at Claude's cache rates: writes at 1.25x input (5-minute TTL), reads at 0.1x input, 0.05x on Claude Opus 5.5 and 0.025x on Claude Fable 5.1.

## [2.1.0] - 2026-10-04

### Added

- `McpHttpConfig` / `resolveAiConfig` read `mcp.http.homebridgeCertFingerprint` and `mcp.http.homebridgeCertPath`: the SHA-256 fingerprint or PEM file of an https Homebridge UI's (self-signed) certificate that ai-kit's MCP server should trust.

## [2.0.2] - 2026-10-04

2.0.1 was tagged but never published (its publish run failed on a lint error); 2.0.2 contains its fixes.

### Fixed

- **"Suggest rooms & names" failed on large installations.** All accessories went into one request, and with a few dozen of them the reply ran past the output limit (2048 tokens by default); the cut-off JSON failed validation and the call ended in an error. `suggestOrganization` now sends the accessories in batches sized to the output limit and merges the replies (rooms with the same name are combined), and it sends short aliases (`a1`, `a2`, …) instead of the long HomeKit uniqueIds, mapping them back afterwards: far fewer tokens, and no ids for the model to mistype.
- **`generateJson` no longer retries a reply cut off at the output limit.** The "repair" retry hit the same limit; it now fails at once with "The answer was cut off at the N-token output limit. Raise the maximum answer length, or ask for less at once."
- **The organiser runs its batches three at a time**, so a large installation takes a fraction of the time it did one batch after another.

## [2.0.0] - 2026-10-04

### Added

- **First release**, split out of `@mp-consulting/homebridge-ai-kit` 2.0.0 (and versioned with it) so Homebridge plugins can use the Assistant without installing the MCP SDK, socket.io-client or zod. The only runtime dependency is `ajv`.
- **`.` export:** provider adapters over plain `fetch` (`createProvider`, `complete`, Claude / OpenAI / Gemini / OpenAI-compatible), secret redaction, the `HomebridgeAiKit` config block (`readAiConfig`, `resolveAiConfig`, `findAiBlock`, `defaultConfigPath`, `PLATFORM_NAME`, `PLUGIN_NAME`, `PROVIDER_NAMES`, `DEFAULT_MODELS` and the other `DEFAULT_*` constants), `PROMPTS`, `trimToContext` / `estimateTokens` / `inputBudget`, `generateJson`, `UsageTracker` / `costOf` / `addUsage`, and the features `diagnoseLogs`, `generatePluginConfig`, `explainDeviceError`, `assessPluginUpdate`, `suggestOrganization`, `dailyDigest`, `ask`.
- **`./plugin` export:** `registerAiRoutes(server, { pluginName?, systemContext? })` (`/ai/status`, `/ai/explain`, `/ai/ask`, `/ai/config`, streamed as `ai:chunk` / `ai:done` / `ai:error`) and `testAiConnection`. The server parameter is typed structurally, so `@homebridge/plugin-ui-utils` is not a dependency.
