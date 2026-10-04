# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **New MCP tool `get_accessory_history`** (read-only): an accessory's recorded sensor values (temperature, humidity, light level, battery, air quality, power, energy) from Homebridge Glass UI's `GET /api/accessories/:uniqueId/history`. Takes `uniqueId`, `hours` (default 24, up to 8760), an optional characteristic `type` and `maxPoints` (default 48, 2–500). Each series comes back with `count`, `min` / `max` with when they happened, the time-weighted `avg`, `last` and the points averaged down to `maxPoints`, times in UTC, so a model can answer "why was the living room cold last night" in one call. The summary is computed from every recorded value, not the downsampled points. 32 tools in all.
- **Trust a Homebridge UI served over HTTPS with a self-signed certificate** without turning verification off: `HOMEBRIDGE_CERT_FINGERPRINT` (plugin: `mcp.http.homebridgeCertFingerprint`) pins the certificate by its SHA-256 fingerprint, and `HOMEBRIDGE_CERT_PATH` (plugin: `mcp.http.homebridgeCertPath`) trusts the certificate or CA in a PEM file on top of the public roots. Only the MCP server's requests to the Homebridge UI are affected (an undici `Agent` used by `HomebridgeClient`, like Glass UI's own loopback fetch); a certificate that doesn't match is refused with an error naming both fingerprints. `HomebridgeClient` takes the same as `certFingerprint` / `certPath` options, and `./mcp` exports `createTrustedFetch()`. New runtime dependency: `undici` ^7.30.0.
- The settings page has fields for both certificate settings.

### Fixed

- **Saving the plugin's settings dropped fields Glass UI writes.** `config.schema.json` now declares `mcp.http.homebridgeTokenId` (the id of the API token Glass UI created for the MCP server, which it needs to revoke that token) and the new certificate settings, so the Homebridge UI keeps them; a test checks that every field the code reads is in the schema. The custom settings page now merges its form into the stored `mcp` / `mcp.http` blocks instead of replacing them, so fields it doesn't show survive a save.
- When the HTTP MCP server can't start, the plugin only suggests setting a Homebridge API token when credentials are what's missing.

### Documentation

- New **MCP tokens** section in the README: what the client token and the Homebridge API token are for, and where to set or generate them (Glass UI's *Settings → Assistant → MCP server*, this plugin's settings page, or the CLI's environment variables).

## [2.0.2] - 2026-10-04

2.0.1 was tagged but never published (its publish run failed on a lint error); 2.0.2 contains its fixes.

### Fixed

- Depends on `@mp-consulting/homebridge-ai-core` ^2.0.2, which fixes:
  - **"Suggest rooms & names" failed on large installations.** All accessories went into one request, and with a few dozen of them the reply ran past the output limit (2048 tokens by default); the cut-off JSON failed validation and the call ended in an error. `suggestOrganization` now sends the accessories in batches sized to the output limit and merges the replies (rooms with the same name are combined), and it sends short aliases (`a1`, `a2`, …) instead of the long HomeKit uniqueIds, mapping them back afterwards: far fewer tokens, and no ids for the model to mistype.
  - **The organiser runs its batches three at a time**, so a large installation takes a fraction of the time.
  - **`generateJson` no longer retries a reply cut off at the output limit.** The "repair" retry hit the same limit; it now fails at once with "The answer was cut off at the N-token output limit. Raise the maximum answer length, or ask for less at once."

### Changed

- The `@mp-consulting/homebridge-ui-kit` dev dependency now comes from npm (`^1.2.0`) instead of a sibling checkout, so CI and the publish workflow can build the settings page assets.

## [2.0.0] - 2026-10-04

### Added

- `HomebridgeClient` accepts a `fetch` option, used for every request instead of the global fetch. Glass UI passes one that trusts its own self-signed certificate, so the Assistant's tools work when the UI runs over HTTPS.

- **New package `@mp-consulting/homebridge-ai-core` (2.0.0, `packages/ai-core`).** The AI building blocks that don't need MCP — providers, redaction, config, prompts, tokens, `generateJson`, usage, the Assistant features and the plugin-UI routes (`registerAiRoutes`, `testAiConnection` from `./plugin`) — now ship on their own with `ajv` as the only runtime dependency. Homebridge plugins should depend on it instead of ai-kit, so they no longer install `@modelcontextprotocol/sdk`, `socket.io-client` and `zod`. Its `PluginUiServer` parameter is typed structurally, so `@homebridge/plugin-ui-utils` is not a dependency. ai-core also exports `addUsage`, `ZERO_USAGE`, `TrimOptions`, `PromptTemplate`, `McpPromptName` and the `DEFAULT_*` config constants, which ai-kit re-exports too.
- **The Assistant (AI core, `.` export).** Provider adapters over plain `fetch` for Claude (`anthropic`, default `claude-sonnet-5-5`), OpenAI, Gemini and any OpenAI-compatible server (Ollama, LM Studio), each declaring its capabilities (tools, streaming, context size). Uniform `chat()` / `stream()` API with tool calling.
- **Agent loop** `runAgent()`: connects a provider to the MCP tools through the MCP SDK's in-memory transport. Destructive tools are refused unless a `confirm` callback allows them; providers without tool calling get a prompt-only answer.
- **Features:** `diagnoseLogs`, `generatePluginConfig` (schema-checked, secrets restored), `explainDeviceError`, `assessPluginUpdate` (low/medium/high risk), `suggestOrganization`, `dailyDigest`, `ask`. Inputs are redacted and trimmed to the provider's context window; all stream through `onChunk`.
- **Utilities:** `generateJson` (ajv validation with one repair retry), `trimToContext` / `estimateTokens`, `UsageTracker` with Claude prices, `PROMPTS` templates, `redactText` for free text, `readAiConfig` / `resolveAiConfig`.
- **Homebridge plugin.** The package is now also a Homebridge platform plugin (`HomebridgeAiKit`) with `config.schema.json` and a custom settings page (built with `@mp-consulting/homebridge-ui-kit`) to choose the provider and model, test the connection, serve MCP over HTTP and copy configs for Claude Desktop, Claude Code and Cursor.
- **`./plugin` export:** `registerAiRoutes(server)` adds `/ai/status`, `/ai/explain`, `/ai/ask` and `/ai/config` to any plugin's custom UI server, streaming `ai:chunk` / `ai:done` / `ai:error` events; plus `testAiConnection` and `mcpClientSnippets`.
- **MCP over Streamable HTTP:** `homebridge-ai-kit mcp --http [--port 8582] [--host 127.0.0.1]` and `runHttpServer()`. Requires a bearer token (`HOMEBRIDGE_AI_MCP_TOKEN`) and binds to 127.0.0.1 by default.
- **API-token login:** `HOMEBRIDGE_TOKEN` (a Glass UI `hbg_…` token) replaces username and password. `new HomebridgeClient({ url, token, getToken, … })` takes options, and `getToken` lets Glass UI act with each user's short-lived token.
- **New MCP tools:** `install_plugin`, `update_plugin`, `uninstall_plugin` and `get_plugin_job` (Glass UI plugin jobs, polled until done), `list_child_bridges`, `restart_child_bridge`, `stop_child_bridge`, `start_child_bridge`, and `patch_config` for editing one platform or accessory block.
- **MCP resources with subscriptions:** `homebridge://accessories`, `homebridge://logs/recent` and `homebridge://status`, updated live from the UI's socket.io namespaces with a polling fallback.
- **MCP prompts:** `diagnose-logs`, `plan-upgrade` and `audit-config`, sharing their text with the Assistant's templates.

### Changed

- **Renamed to `@mp-consulting/homebridge-ai-kit`** (was `@mp-consulting/homebridge-mcp-server`). The package becomes the home for all AI features shared by Homebridge Glass UI and the MP Consulting plugins; the MCP server is its first part.
- **New command: `homebridge-ai-kit mcp`.** The `homebridge-mcp-server` command is kept as an alias, and the environment variables are unchanged, so existing MCP client configs keep working.
- **The MCP server reports its name as `homebridge-ai-kit`** instead of `homebridge-mcp-server`. Clients that match on the server name need updating.
- **Breaking for library users:** the package entry point no longer starts the server. Import `createServer` and `HomebridgeClient` from `@mp-consulting/homebridge-ai-kit/mcp`; secret redaction (`redactSecrets`, `restoreSecrets`) is exported from the main entry.
- **`set_accessory` checks the value before sending it** against the characteristic's format, range, step, valid values and write permission, and coerces e.g. `"50"` to `50`.
- Redaction no longer hides token *counts* such as `maxOutputTokens` or `contextTokens`.
- **The repository is an npm workspace.** ai-kit depends on `@mp-consulting/homebridge-ai-core` `^2.0.0` and re-exports all of it from `.` and `./plugin` under the same names, so imports from ai-kit (Homebridge Glass UI) keep working. `ajv` is no longer a direct dependency of ai-kit. Root `build`, `typecheck`, `lint`, `test` and `test:coverage` cover both packages, building ai-core first.
- **Releases publish two packages.** The publish workflow publishes ai-core first (skipped when that version is already on npm), then ai-kit. Before the first release, configure npm trusted publishing (OIDC) for the new `@mp-consulting/homebridge-ai-core` package name, and make sure ai-core is published before ai-kit.

## [1.2.2] - 2026-10-03

### Changed

- **Dependabot is enabled.** It opens pull requests for outdated npm dependencies (weekly) and GitHub Actions (monthly), and GitHub now alerts on and fixes vulnerable dependencies. The plugin itself is unchanged.

## [1.2.1] - 2026-10-03

### Fixed

- **Package metadata**: `repository.url` in `package.json` now uses the canonical `git+https://…git` form, so `npm publish` no longer has to auto-correct it.

## [1.2.0] - 2026-10-03

### Security

- **`search_logs` can no longer hang the server.** The 5-second budget was only checked between lines, so a backtracking regex such as `^(a+)+$` blocked the whole process on a single line (measured: 23 s for a 27-character line, minutes for 31). Regex matching now runs in a worker thread that is terminated when the budget runs out.
- **`get_config` redacts secrets.** Passwords, tokens, API keys and the bridge pin are replaced with `__REDACTED__` before the config reaches the model, and `update_config` restores the real values (matching array entries by `platform`/`accessory`/`name`, never by position alone). Use `includeSecrets: true` to see them.
- **`update_config` validates its input**: the config must contain a `bridge` object, so an empty or truncated object can no longer replace `config.json`.
- **Read-only mode**: `HOMEBRIDGE_READ_ONLY=true` removes every tool that changes state.
- Every tool now declares MCP annotations (`readOnlyHint`, `destructiveHint`, ...), so clients can confirm restarts, cache resets and config writes.
- Startup warns when `HOMEBRIDGE_URL` would send the password over plain `http` to a non-local host.
- Refreshed the lockfile to clear `npm audit` advisories in transitive dependencies of the MCP SDK (`hono`, `@hono/node-server`, `fast-uri`, `ip-address`). None are reachable from this stdio-only server.

### Added

- `HOMEBRIDGE_TIMEOUT_MS` (default 30 s): every request to Homebridge now times out instead of hanging forever when the host is unreachable.
- `remove_cached_accessory` accepts a `cacheFile`, so accessories on a child bridge can be removed. `get_cached_accessories` reports each accessory's `cacheFile`.
- `verbose` option on `list_plugins`, `search_plugins` and `get_cached_accessories` to get the full API objects.

### Changed

- **Tool output is compact JSON** instead of pretty-printed, about 25% fewer tokens for the same data.
- `list_plugins`, `search_plugins` and `get_cached_accessories` return a summary of the useful fields by default (pass `verbose: true` for everything).
- `get_accessory` fetches the single accessory (`GET /api/accessories/:uniqueId`) instead of downloading the whole list.
- `list_accessories` with a `room` filter fetches the accessories and the layout in parallel.
- The log tools stream the log and keep only the last 16 MB in memory, instead of downloading the whole file first.
- Error messages no longer repeat `Error:` (`Error listing plugins: fail`, not `Error listing plugins: Error: fail`), and network failures say which host could not be reached and why.
- Migrated from the deprecated `server.tool()` to `registerTool()`, with a title on every tool.

### Fixed

- The server reported version `1.0.1` to MCP clients regardless of the installed version; it now reads it from `package.json`.
- Parallel requests (e.g. `get_accessory_layout`) each performed their own login, and parallel 401s each triggered a token refresh. Logins and refreshes are now shared.
- A missing or invalid environment variable now prints a one-line error instead of a stack trace. `HOMEBRIDGE_URL` is validated up front.

## [1.1.0] - 2026-09-10

### Added

- **Log tools**: `get_recent_logs` returns the most recent lines of the Homebridge log, and `search_logs` finds matching lines by substring or regex (`regex`, `caseSensitive` and `limit` options). Both read the log over the Homebridge UI API (`GET /api/platform-tools/hb-service/log/download`), so they work against a remote instance and require an hb-service based install.

### Changed

- **Dependencies**: Updated all dependencies to latest compatible versions, including `@modelcontextprotocol/sdk` ^1.30.0 and `zod` ^4.5.4, plus dev-only major bumps for `vitest` (4→5) and `@types/node` (25→26).

## [1.0.7] - 2026-08-09

### Changed

- **Node.js support is now `^22.10.0 || ^24.0.0 || ^26.0.0`**: adds Node 26, which Homebridge 2.3.0 supports as of this release, and drops Node 20. Homebridge 2.x has never accepted Node 20 (it has required `^22 || ^24` since 2.0.0), so the previous range advertised a combination that could not actually run. CI now builds on Node 22.x, 24.x and 26.x.

## [1.0.4] - 2026-04-04

### Changed

- **Node.js**: Add Node.js 24.x support to CI matrix and standardize engines to `^20.18.0 || ^22.10.0 || ^24.0.0`

## [1.0.3] - 2026-03-30

### Fixed

- TypeScript 6 build fix

## [1.0.2] - 2026-03-30

### Changed

- **Dependencies**: Updated all dependencies to latest versions including `@modelcontextprotocol/sdk` ^1.29.0, `zod` ^4.3.6, `eslint` ^10.1.0, `typescript` ^6.0.2, `vitest` ^4.1.2, and other dev dependencies.

## [1.0.1] - 2026-02-22

### Added

- `CLAUDE.md` with project conventions and context for Claude Code
- SemVer and Keep a Changelog conventions

### Changed

- Improved `README.md` with filtering parameters docs, dev commands, and correct repo URL

## [1.0.0] - 2026-02-22

### Added

- MCP server with stdio transport for AI assistant integration
- Homebridge REST API client with JWT authentication and automatic token refresh
- **Accessories tools:** list, get, set accessories with filtering by room, type, manufacturer, and name
- **Accessory layout:** room-based organization from Homebridge UI
- **Server tools:** status, restart, pairing info, cached accessories management
- **Config tools:** read and update Homebridge `config.json`
- **Plugin tools:** list, search, lookup, versions, config schema, and changelog
- **System tools:** CPU, memory, OS, and network information
- Full test suite with Vitest
- GitHub Actions CI workflow (Node.js 18, 20, 22)
