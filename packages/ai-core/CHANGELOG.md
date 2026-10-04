# Changelog

All notable changes to `@mp-consulting/homebridge-ai-core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
