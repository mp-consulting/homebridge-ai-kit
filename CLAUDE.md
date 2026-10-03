# CLAUDE.md

## Project Overview

Homebridge MCP Server — a Model Context Protocol server that bridges AI assistants (Claude) with Homebridge to control smart home accessories, manage plugins, and monitor the Homebridge instance.

## Tech Stack

- **Language:** TypeScript (strict mode, ES2022, ESM via NodeNext)
- **Runtime:** Node.js `^22.10.0 || ^24.0.0 || ^26.0.0`
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Validation:** Zod
- **Test framework:** Vitest
- **Build:** `tsc` (output to `dist/`)

## Project Structure

```
src/
├── index.ts                 # Entry point — reads env, prints startup errors, connects stdio
├── create-server.ts         # createServer(client, { readOnly }) — registers every tool group
├── homebridge-client.ts     # HTTP client for Homebridge REST API (JWT auth, timeouts)
├── config-secrets.ts        # redact / restore secrets in config.json
├── regex-search.ts          # regex log search in a killable worker thread
├── types.ts                 # RegisterTools signature + Homebridge API shapes
└── tools/
    ├── helpers.ts           # registrar (read-only filter), result helpers, handle(), pick()
    ├── accessories.ts       # list, get, set accessories + room layout
    ├── server.ts            # status, restart, pairing, cached accessories
    ├── config.ts            # read/update config.json
    ├── plugins.ts           # list, search, lookup, versions, changelog
    ├── system.ts            # system info (CPU, memory, OS)
    └── logs.ts              # recent logs, search logs
```

Tests mirror the source structure under `test/`; shared mocks live in `test/helpers.ts`.

## Commands

- `npm run build` — compile TypeScript
- `npm run dev` — run with tsx (hot reload)
- `npm test` — run tests (vitest run)
- `npm run test:watch` — run tests in watch mode
- `npm run test:coverage` — tests with coverage thresholds (CI runs this)
- `npm run lint` — ESLint, zero warnings allowed
- `npm run typecheck` — type-check `src` and `test` (plain `tsc` only covers `src`)

## Architecture Patterns

- Each `tools/*.ts` file exports `register: RegisterTools`, a `(tool, client)` function. `tool` is the registrar from `createRegistrar()`, a thin wrapper over `McpServer.registerTool` that skips non-read-only tools in read-only mode.
- Every tool must declare `title`, `description` and `annotations` (with `readOnlyHint`; write tools also set `destructiveHint`). Use the `READ` / `READ_REGISTRY` presets for read-only tools.
- Wrap handlers in `handle('<verb>ing <thing>', async (args) => ...)` and return `jsonResult()` / `textResult()` / `errorResult()`. Output is compact JSON.
- `HomebridgeClient` handles all HTTP communication with the Homebridge REST API: JWT auth with a single shared login/refresh, one retry on 401, and a per-request timeout.
- The server uses stdio transport (`StdioServerTransport`). stdout is the protocol, so log only to stderr.

## Environment Variables

- `HOMEBRIDGE_URL` — Homebridge instance URL (e.g. `http://192.168.2.200:8581`)
- `HOMEBRIDGE_USERNAME` — login username
- `HOMEBRIDGE_PASSWORD` — login password
- `HOMEBRIDGE_READ_ONLY` — optional; `true` registers only read-only tools
- `HOMEBRIDGE_TIMEOUT_MS` — optional; request timeout (default 30000)

## Key Conventions

- All API calls go through `HomebridgeClient.fetchAuthed()` / `request()`, which handle auth, retries and timeouts.
- Tool inputs are validated with Zod schemas in each tool's `inputSchema`. Validation runs inside `McpServer`, so test it through `createServer` (see `test/create-server.test.ts`), not by calling handlers directly.
- Never put user-supplied regexes on the main thread; use `regexSearch()`.
- Anything that returns `config.json` must go through `redactSecrets()` unless the caller explicitly asked for secrets.
- Room filtering in `list_accessories` uses the Homebridge UI layout (`/api/accessories/layout`), not HomeKit rooms.
- Tests use `vi.fn()`, `vi.stubGlobal()` and `vi.stubEnv()` for mocking — no real API calls in tests. Use `mockClient()` / `collectHandlers()` from `test/helpers.ts`.
- **Always keep `README.md` and `CHANGELOG.md` up to date** when adding features, fixing bugs, or making any notable change.
- **Follow [Semantic Versioning](https://semver.org/)** — bump MAJOR for breaking changes, MINOR for new features, PATCH for bug fixes.
- **Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)** format in `CHANGELOG.md` — use Added, Changed, Deprecated, Removed, Fixed, Security sections.
- **Write clear commit messages** — concise subject line describing the "why", not just the "what".
