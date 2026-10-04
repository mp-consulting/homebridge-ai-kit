# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-10-05

### Breaking

- `set_accessory` refuses lock, garage door and security system targets; use the new destructive `set_security_accessory` tool, which asks for confirmation.
- `get_config`'s `includeSecrets` is opt-in (`HOMEBRIDGE_ALLOW_SECRETS`, or the `allowSecrets` option for `createServer` / `runHttpServer`) and never available in read-only mode.
- `RegisterTools` takes a third `options` argument, and write tools declare a token `scope`.
- The default OpenAI model is `gpt-6.1-sol` (over the Responses API) and the default Gemini model `gemini-3.8-flash`.

### Added

- **OpenAI through the Responses API** (from ai-core): the `openai` provider calls `/responses` with `store: false`, which newer OpenAI models need for tool calling, and replays their encrypted reasoning in agent loops. The new `openaiApi` setting (`responses` | `chat`, in `config.schema.json`) switches back to Chat Completions for proxies or local servers that only speak it (`openai-compatible` keeps Chat Completions by default). The `effort` setting now also applies to OpenAI (`reasoning.effort`).
- **Assistant requests are retried** when the provider is busy, rate limits them or can't be reached (from ai-core): new `maxRetries` setting (default 2, 0 turns it off) in `config.schema.json` and the README.
- **Claude prompt caching and `effort`** (from ai-core): agent loops reuse the cached tools, system prompt and conversation, and the new `effort` setting (`config.schema.json`, Claude only) controls how much Claude thinks. Costs now price cache reads and writes correctly.
- Usage tracking that survives restarts, with daily / monthly totals and optional token or USD budgets (`UsageTracker`, `JsonFileUsageStore`, `trackUsage`, from ai-core).
- `./mcp` also exports `normalizeFingerprint` and `pemFingerprints`, next to `createTrustedFetch`, so apps can pin the Homebridge UI certificate without their own copy.
- Server helpers from ai-core, re-exported from `.`: `SlidingWindowRateLimiter`, `TtlCache`, `withConfirmTimeout`, `ConfirmationBroker`, `redactPairing`, `readLogTail`, `tailLines`, `stripAnsi`. The `homebridge://logs/recent` resource uses ai-core's ANSI stripping, which also removes cursor and erase codes.
- **Config safety.** `update_config` and `patch_config` take `dryRun: true`, which returns what would change without writing: a list of changed JSON paths and a unified diff of the pretty-printed file, both with secrets redacted. Every real write now names the config.json backup the Homebridge UI made of the previous file (both Homebridge UI and Glass UI copy config.json to `backups/config-backups` before each save, so no local store is needed), with the `restore_config` call that undoes it.
- **New MCP tools `list_config_backups`** (read-only, `GET /api/config-editor/backups`) **and `restore_config`** (destructive; reads `GET /api/config-editor/backups/:id` and saves it, so the replaced file is itself backed up; supports `dryRun`).
- **New MCP tools `create_backup` and `list_backups`**: create a full instance backup in the UI's backup directory (`POST /api/backup`) and list those backups (`GET /api/backup/scheduled-backups`). A UI without these routes gets a clear "requires Homebridge Glass UI" error.
- **New MCP tool `set_accessories`**: set one characteristic on many accessories at once, picked by `uniqueIds` or by the `list_accessories` filters (`room`, `type`, `name`, `manufacturer`, `excludeManufacturer`). Each value is checked per accessory like `set_accessory`; `dryRun` previews current → new value per target; the result lists each target's outcome and the skipped ones with the reason. At most 25 targets unless `maxTargets` (up to 200) is raised. Lock, garage door and security system targets (`LockTargetState`, `TargetDoorState`, `SecuritySystemTargetState`) are refused and pointed to `set_accessory`.
- **Scenes (Homebridge Glass UI): `list_scenes`, `run_scene`, `save_scene`.** `run_scene` takes a scene id or name (`POST /api/scenes/:id/run`) and returns the result per action; a scene that changes a lock, garage door or security system is refused (apply those actions with `set_security_accessory`, which asks the user, or run the scene in Glass UI). `save_scene` captures the current writable values of the chosen accessories (optionally only some characteristics; never lock/door/alarm states, `Identify` or names) and creates the scene with `POST /api/scenes`, with a `dryRun` preview.
- **New MCP tool `get_child_bridge_health`** (Glass UI, `GET /api/status/homebridge/child-bridges/health`): status, uptime, restart and crash counts and crash-loop detection per child bridge, optionally for one `deviceId`.
- **New MCP tool `send_test_notification`** (Glass UI, `POST /api/notifications/test`): send a test message to one notification channel or every enabled one.
- **`search_logs` filters**: `since` / `until` (ISO, or a duration back from now such as `30m`, `1h`, `2d`), a minimum `level` (`error`, `warn`, `info`, `debug`, read from the colours Homebridge's logger writes, so the log is fetched with `colour=yes` when it is used; falls back to the words in the line), `plugin` (the `[Prefix]` after the timestamp) and `context` (lines around each match, grep `-C` style). Lines without a timestamp, such as stack traces, belong to the entry above. `pattern` is now optional when a filter is given.
- **MCP resource templates** `homebridge://accessory/{uniqueId}`, `homebridge://plugin/{name}` and `homebridge://child-bridge/{id}`, each listed in `resources/list` (a Homebridge error lists nothing rather than failing the list) and with completion for its variable. Child bridges never include pairing codes.
- **MCP prompts `troubleshoot-device`, `nightly-health-check` and `scene-builder`**: guided workflows over the tools (device state → plugin → child bridge health → logs; a read-only health report; a scene proposed, confirmed, applied with `set_accessories` and saved with `save_scene`).
- **Structured tool output.** `list_accessories`, `get_accessory`, `list_plugins`, `list_child_bridges`, `get_child_bridge_health`, `get_homebridge_status`, `get_server_status`, `search_logs` and `list_scenes` declare an `outputSchema` and return `structuredContent` (lists wrapped as `{ accessories: [...] }`, `{ plugins: [...] }`, …; `search_logs` gives `{ total, shown, truncated, matches: [{ line, time, level, plugin, text }] }`). The text block keeps the JSON these tools always returned. Schemas are loose so extra fields from newer Homebridge UIs pass.
- **Server-side confirmation through MCP elicitation.** When the connected client advertises form elicitation, every destructive tool (`destructiveHint: true`) asks the user to confirm before it runs, showing its arguments with secrets redacted. Declined, cancelled or failed confirmations return an error and nothing runs; `dryRun` calls are not asked. Clients without elicitation (including `runAgent`, which keeps its `confirm` callback) behave as before. On by default; `HOMEBRIDGE_ELICITATION=false` or `createServer(client, { elicitation: false })` turns it off.
- `HomebridgeClient` throws a `HomebridgeApiError` (with `status`, `method`, `path`, `body` and `missingRoute`) for non-2xx answers, same message as before; `requireGlassUi()` turns a missing route into a readable error.
- **Scoped client tokens.** Besides the main client token (still full access), the HTTP MCP server takes more tokens, each `read` (read-only tools), `control` (plus `set_accessory` / `set_security_accessory`) or `admin` (everything): `clients` option, `mcp.http.clients` (`{ name, token, scope }`), or `HOMEBRIDGE_AI_MCP_TOKENS=read:abc,control:def` for the CLI. A session belongs to the token that opened it (`403` for another token). Tools declare the scope they need with a new `scope` field in their config (write tools default to `admin`); `createServer` takes `scope`.
- **Read-only HTTP from the plugin.** `mcp.http.readOnly` caps every client token at `read`; the plugin passed no read-only setting before.
- **Audit log of write tool calls**: one JSON object per line with time, tool, arguments (secrets redacted with `redactSecrets`), result (`ok` / `error`), MCP session, client name, token name and scope. The plugin writes it to `<Homebridge storage>/homebridge-ai-kit-audit.jsonl` by default (`mcp.http.auditLog`, `mcp.http.auditLogPath`); the CLI with `HOMEBRIDGE_AI_AUDIT_LOG=<path>`. It rotates at 5 MB, keeping three old files. `./mcp` exports `createAuditLog()`, and `createServer` / `runHttpServer` take any `audit` sink.
- The plugin's settings page has switches for read-only and the audit log, the audit log path and the allowed browser origins (scoped tokens are edited in the JSON config).

### Changed

- The settings page uses `@mp-consulting/homebridge-ui-kit` 1.3: `lib/theme-boot.js` applies the theme before first paint and `MpKit.Theme.init()` follows the Homebridge setting (its own theme script is gone), and only the minified kit files are copied (`mp-ui-kit-copy --only`).
- Depends on `@mp-consulting/homebridge-ai-core` ^2.2.0.
- **The default OpenAI model is `gpt-6.1-sol`** (was `gpt-5`, whose snapshot OpenAI shuts down on 2026-12-11), in ai-core, the settings page, `config.schema.json` and the README.
- **The default Gemini model is `gemini-3.8-flash`** (was `gemini-2.5-pro`, which Google now limits to projects that already used it), in ai-core, the settings page and `config.schema.json`.
- `update_config` no longer echoes the Homebridge UI's answer, which is the saved file with its secrets; it returns a short confirmation instead.
- **HTTP sessions expire.** A session with no request for 30 minutes is closed (`sessionIdleMs`, `HOMEBRIDGE_AI_MCP_SESSION_IDLE_MINUTES`), and at most 32 stay open (`maxSessions`, `HOMEBRIDGE_AI_MCP_MAX_SESSIONS`); the least recently used idle session makes room for a new one. Sessions with an open stream are never idle.
- **One change feed for all HTTP sessions.** Sessions subscribed to the same resource now share a single socket.io connection (or poller) to Homebridge instead of opening one each. `./mcp` exports `shareLiveSource()`.
- **Behaviour changes for clients:** `set_accessory` now refuses locks, garage doors and security systems (use `set_security_accessory`), and `get_config` only offers `includeSecrets` with `HOMEBRIDGE_ALLOW_SECRETS`. Library callers of `createServer` / `runHttpServer` must pass `allowSecrets: true` to keep returning secrets.
- Needs the unreleased `@mp-consulting/homebridge-ai-core` changes in this workspace (new `mcp.http` settings and the base prompt rule); release ai-core first and raise the dependency.
- Log text is cleaned with ai-core's `stripAnsi` (all escape codes, not just colours).
- Tests cover the MCP prompts, the CLI's env parsing (`stdio.ts`) and the custom UI server (`homebridge-ui/server.js`).

### Fixed

- **The settings page follows your Homebridge theme.** It applied the system's light/dark preference (after hard-coding dark in the markup) and ignored the Homebridge user setting; it now applies the user's light, dark or auto setting (`homebridge.getUserSettings()` where available, else `userCurrentLightingMode()`), following the system in auto mode and when it changes.
- The settings page no longer loads `lib/ai.css` on top of `lib/kit.css`, which already contains the Assistant components, and its theme script and styles moved from inline blocks into same-origin files (`js/theme.js`, `css/app.css`) so they work under the Homebridge UI's content-security policy.

### Security

- **One rule for locks, garage doors and alarms.** `set_accessory`, `set_accessories`, `run_scene` and `save_scene` share one check (`isSecurityWrite()`: the lock / door / alarm characteristics, or any characteristic of a `LockMechanism`, `LockManagement`, `GarageDoorOpener` or `SecuritySystem` accessory) and point to `set_security_accessory`, the only tool that writes them; it is destructive, so MCP clients, server-side elicitation and `runAgent` all ask the user. `run_scene` no longer takes `confirm: true` for such scenes: a flag the model sets is not the user's consent.
- **Token scopes cover the new tools**: `set_accessories` and `run_scene` need `control`; `save_scene`, `restore_config`, `create_backup`, `send_test_notification` and the config writes (dry runs included) need `admin`.
- **The audit log records declined confirmations** (`notConfirmed: true`, from MCP elicitation or `runAgent`'s `confirm`), and `runAgent` takes an `audit` sink (principal `agent`).
- The `homebridge://logs/recent` resource and `search_logs`' text are marked as untrusted data; `structuredContent` stays raw.
- **Unlocking a door now needs the user's consent.** `set_accessory` is non-destructive, so MCP clients and `runAgent` never asked before it unlocked a lock, opened a garage door or disarmed an alarm. Those writes (`LockTargetState`, `TargetDoorState`, `SecuritySystemTargetState`, and any characteristic of a `LockMechanism`, `LockManagement`, `GarageDoorOpener` or `SecuritySystem` service) now go through the new **`set_security_accessory`** tool, annotated `destructiveHint: true`, and `set_accessory` refuses them with a pointer to it. A separate tool rather than a per-call check keeps the MCP annotations truthful for every client, not just `runAgent`; light and switch writes still don't prompt. 43 tools in all, with the other tools added in this release.
- **Read-only mode no longer hands out secrets.** `get_config`'s `includeSecrets` returned real passwords and tokens even with `HOMEBRIDGE_READ_ONLY`. It now only exists when the server opts in with `HOMEBRIDGE_ALLOW_SECRETS=true` (`allowSecrets` for `createServer` / `runHttpServer`), and never in read-only mode; otherwise the parameter is gone and secrets stay redacted. `runAgent` never allows it.
- **Prompt-injection hardening.** Homebridge-sourced free text (`get_recent_logs`, `search_logs`, `get_plugin_changelog`) is wrapped in `<untrusted-data source="…">` delimiters, and `runAgent` wraps every tool result it sends to the model the same way (the `toolCalls` it returns keep the raw text). A delimiter inside the data is defused so it can't close the block early. The shared base system prompt (`PROMPTS.base`, from ai-core) now says tool output is untrusted data, never to follow instructions in it, and to change devices, config or plugins only when the user asked.
- **The HTTP MCP server checks the `Origin` header**, as the MCP Streamable HTTP spec requires, so a web page can't reach it through DNS rebinding. Requests without `Origin` (desktop clients) are unaffected; browser requests must come from a loopback origin, the server's own IP address, or an origin listed in the new `allowedOrigins` option (`HOMEBRIDGE_AI_MCP_ALLOWED_ORIGINS`, plugin: `mcp.http.allowedOrigins`). Others get `403`.
- **Repeated bad tokens are slowed down.** After 5 failed attempts from one address, the server answers `429` with `Retry-After`, doubling the wait up to 5 minutes; a correct token resets the count.

## [2.1.0] - 2026-10-04

### Added

- **New MCP tool `get_accessory_history`** (read-only): an accessory's recorded sensor values (temperature, humidity, light level, battery, air quality, power, energy) from Homebridge Glass UI's `GET /api/accessories/:uniqueId/history`. Takes `uniqueId`, `hours` (default 24, up to 8760), an optional characteristic `type` and `maxPoints` (default 48, 2–500). Each series comes back with `count`, `min` / `max` with when they happened, the time-weighted `avg`, `last` and the points averaged down to `maxPoints`, times in UTC, so a model can answer "why was the living room cold last night" in one call. The summary is computed from every recorded value, not the downsampled points. 32 tools in all.
- **Trust a Homebridge UI served over HTTPS with a self-signed certificate** without turning verification off: `HOMEBRIDGE_CERT_FINGERPRINT` (plugin: `mcp.http.homebridgeCertFingerprint`) pins the certificate by its SHA-256 fingerprint, and `HOMEBRIDGE_CERT_PATH` (plugin: `mcp.http.homebridgeCertPath`) trusts the certificate or CA in a PEM file on top of the public roots. Only the MCP server's requests to the Homebridge UI are affected (an undici `Agent` used by `HomebridgeClient`, like Glass UI's own loopback fetch); a certificate that doesn't match is refused with an error naming both fingerprints. `HomebridgeClient` takes the same as `certFingerprint` / `certPath` options, and `./mcp` exports `createTrustedFetch()`. New runtime dependency: `undici` ^7.30.0.
- The settings page has fields for both certificate settings.

### Fixed

- Depends on `@mp-consulting/homebridge-ai-core` ^2.1.0, which reads the new certificate settings.
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
