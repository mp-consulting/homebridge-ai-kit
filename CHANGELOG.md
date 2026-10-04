# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - Unreleased

### Deprecated

- **Renamed to `@mp-consulting/homebridge-ai-kit`.** This last release has no code of its own: it depends on `@mp-consulting/homebridge-ai-kit` ^2.0.0, and its `homebridge-mcp-server` command runs that package's MCP server (printing a one-line notice to stderr), so existing MCP client configs keep working. Its main export re-exports `@mp-consulting/homebridge-ai-kit/mcp`.

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
