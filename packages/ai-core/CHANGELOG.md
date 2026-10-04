# Changelog

All notable changes to `@mp-consulting/homebridge-ai-core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - Unreleased

### Added

- **First release**, split out of `@mp-consulting/homebridge-ai-kit` 2.0.0 (and versioned with it) so Homebridge plugins can use the Assistant without installing the MCP SDK, socket.io-client or zod. The only runtime dependency is `ajv`.
- **`.` export:** provider adapters over plain `fetch` (`createProvider`, `complete`, Claude / OpenAI / Gemini / OpenAI-compatible), secret redaction, the `HomebridgeAiKit` config block (`readAiConfig`, `resolveAiConfig`, `findAiBlock`, `defaultConfigPath`, `PLATFORM_NAME`, `PLUGIN_NAME`, `PROVIDER_NAMES`, `DEFAULT_MODELS` and the other `DEFAULT_*` constants), `PROMPTS`, `trimToContext` / `estimateTokens` / `inputBudget`, `generateJson`, `UsageTracker` / `costOf` / `addUsage`, and the features `diagnoseLogs`, `generatePluginConfig`, `explainDeviceError`, `assessPluginUpdate`, `suggestOrganization`, `dailyDigest`, `ask`.
- **`./plugin` export:** `registerAiRoutes(server, { pluginName?, systemContext? })` (`/ai/status`, `/ai/explain`, `/ai/ask`, `/ai/config`, streamed as `ai:chunk` / `ai:done` / `ai:error`) and `testAiConnection`. The server parameter is typed structurally, so `@homebridge/plugin-ui-utils` is not a dependency.
