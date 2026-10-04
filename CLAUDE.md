# CLAUDE.md

## Project Overview

Homebridge AI Kit (`@mp-consulting/homebridge-ai-kit`, renamed from `homebridge-mcp-server`) — the home for all MP Consulting Homebridge AI code. It contains: a Model Context Protocol server (stdio + Streamable HTTP) that bridges AI assistants with Homebridge; the Assistant core (provider adapters over plain `fetch`, an agent loop that drives the MCP tools in-process, and ready-made features); and a Homebridge platform plugin (`HomebridgeAiKit`) with a custom settings UI. Package exports: `.` (AI core + Homebridge plugin default export), `./mcp`, `./plugin`.

## Tech Stack

- **Language:** TypeScript (strict mode, ES2022, ESM via NodeNext)
- **Runtime:** Node.js `^22.10.0 || ^24.0.0 || ^26.0.0`
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **JSON Schema validation:** ajv · **Live updates:** socket.io-client · **Plugin UI:** `@homebridge/plugin-ui-utils`, `@mp-consulting/homebridge-ui-kit`
- **Validation:** Zod
- **Test framework:** Vitest
- **Build:** `tsc` (output to `dist/`)

## Project Structure

```
src/
├── index.ts                     # `.` — AI core exports + `export default` Homebridge plugin initializer
├── bin/
│   ├── homebridge-ai-kit.ts     # CLI — `homebridge-ai-kit mcp [--http --port --host]`
│   └── homebridge-mcp-server.ts # Alias kept for configs written for the old package name
├── core/
│   ├── config.ts                # AiConfig, resolveAiConfig(), readAiConfig() — the HomebridgeAiKit block
│   ├── prompts.ts               # PROMPTS — feature templates + MCP prompt texts
│   ├── json.ts                  # generateJson() (ajv + one repair retry), normalizePluginSchema()
│   ├── tokens.ts                # estimateTokens(), trimToContext(), inputBudget()
│   ├── usage.ts                 # UsageTracker, costOf(), Claude price table
│   └── redaction.ts             # redact / restore secrets in config.json, redactText() for free text
├── providers/
│   ├── types.ts                 # AiProvider, ChatRequest/Result/Chunk, ToolDefinition, ProviderError
│   ├── http.ts                  # postJson(), SSE parser, shared helpers
│   ├── anthropic.ts             # Messages API (tool_use, SSE, thinking blocks replayed verbatim)
│   ├── openai.ts                # Chat Completions (also openai-compatible: Ollama, LM Studio)
│   ├── gemini.ts                # generateContent / streamGenerateContent, functionDeclarations
│   └── index.ts                 # createProvider(), complete() (stream-or-chat helper)
├── agent/
│   └── run-agent.ts             # runAgent() — provider ↔ in-memory MCP client loop, confirm for destructive tools
├── features/
│   └── index.ts                 # diagnoseLogs, generatePluginConfig, explainDeviceError, assessPluginUpdate, …
├── plugin/
│   ├── index.ts                 # `./plugin` export
│   ├── platform.ts              # AiKitPlatform — logs status, optionally runs the HTTP MCP server
│   ├── routes.ts                # registerAiRoutes() for plugin-ui-utils servers, testAiConnection()
│   └── snippets.ts              # mcpClientSnippets() for Claude Desktop / Claude Code / Cursor
└── mcp/
    ├── index.ts                 # `./mcp` export
    ├── stdio.ts                 # runStdioServer() / runHttpFromEnv() — env wiring for the CLI
    ├── http.ts                  # runHttpServer() — Streamable HTTP, bearer token, per-session servers
    ├── create-server.ts         # createServer(client, { readOnly, live }) — tools, resources, prompts
    ├── homebridge-client.ts     # HTTP client for the Homebridge UI REST API (login, API token or getToken)
    ├── live.ts                  # createLiveSource() — socket.io change feed with polling fallback
    ├── resources.ts             # homebridge:// resources + resources/subscribe
    ├── prompts.ts               # MCP prompts (text from core/prompts.ts)
    ├── regex-search.ts          # regex log search in a killable worker thread
    ├── types.ts                 # RegisterTools signature + Homebridge API shapes
    └── tools/
        ├── helpers.ts           # registrar (read-only filter), result helpers, handle(), pick()
        ├── accessories.ts       # list, get, set (value checked vs metadata), room layout
        ├── server.ts            # status, restart, pairing, cached accessories
        ├── child-bridges.ts     # list / restart / stop / start child bridges
        ├── config.ts            # get / update / patch config.json
        ├── plugins.ts           # list, search, lookup, versions, changelog
        ├── plugin-jobs.ts       # install / update / uninstall (Glass UI jobs, polled), get_plugin_job
        ├── system.ts            # system info (CPU, memory, OS)
        └── logs.ts              # recent logs, search logs
config.schema.json               # Homebridge plugin schema (pluginAlias HomebridgeAiKit, customUi)
homebridge-ui/
├── server.js                    # custom UI server: registerAiRoutes + /ai/test, /mcp/token, /mcp/snippets
└── public/                      # settings page; lib/ is copied from homebridge-ui-kit at build (gitignored)
```

Tests mirror the source structure under `test/`; shared MCP mocks live in `test/mcp/helpers.ts`, and `test/providers/helpers.ts` has `stubFetch()`, `sseResponse()` and `fakeProvider()`.

## Commands

- `npm run build` — copy ui-kit assets into `homebridge-ui/public/lib` (`mp-ui-kit-copy --vendor`), then compile TypeScript
- `npm run dev` — run the MCP server with tsx
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
- The CLI uses stdio (`StdioServerTransport`; stdout is the protocol, so log only to stderr) or Streamable HTTP (`--http`, one McpServer per session, bearer token required).
- Providers are plain `fetch` (no SDKs). An assistant turn keeps the provider's raw content in `ChatMessage.providerContent` so Claude thinking blocks / Gemini thought signatures are replayed verbatim in tool loops.
- Features take `{ provider, onChunk?, signal?, systemContext? }`, redact every input (`redactSecrets` / `redactText`) and trim it with `trimToContext` against `provider.capabilities.contextTokens`.

## Environment Variables

- `HOMEBRIDGE_URL` — Homebridge instance URL (e.g. `http://192.168.2.200:8581`)
- `HOMEBRIDGE_TOKEN` — Homebridge UI API token (replaces username/password)
- `HOMEBRIDGE_USERNAME` — login username
- `HOMEBRIDGE_PASSWORD` — login password
- `HOMEBRIDGE_AI_MCP_TOKEN` — bearer token required by `mcp --http`
- `HOMEBRIDGE_READ_ONLY` — optional; `true` registers only read-only tools
- `HOMEBRIDGE_TIMEOUT_MS` — optional; request timeout (default 30000)

## Key Conventions

- All API calls go through `HomebridgeClient.fetchAuthed()` / `request()`, which handle auth, retries and timeouts.
- Tool inputs are validated with Zod schemas in each tool's `inputSchema`. Validation runs inside `McpServer`, so test it through `createServer` (see `test/mcp/create-server.test.ts`), not by calling handlers directly.
- Never put user-supplied regexes on the main thread; use `regexSearch()`.
- Anything that returns `config.json` must go through `redactSecrets()` unless the caller explicitly asked for secrets.
- Room filtering in `list_accessories` uses the Homebridge UI layout (`/api/accessories/layout`), not HomeKit rooms.
- Tests use `vi.fn()`, `vi.stubGlobal()` and `vi.stubEnv()` for mocking — no real API or LLM calls in tests (providers are tested with a stubbed `fetch`). Use `mockClient()` / `collectHandlers()` from `test/mcp/helpers.ts`.
- **Always keep `README.md` and `CHANGELOG.md` up to date** when adding features, fixing bugs, or making any notable change.
- **Follow [Semantic Versioning](https://semver.org/)** — bump MAJOR for breaking changes, MINOR for new features, PATCH for bug fixes.
- **Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)** format in `CHANGELOG.md` — use Added, Changed, Deprecated, Removed, Fixed, Security sections.
- **Write clear commit messages** — concise subject line describing the "why", not just the "what".
