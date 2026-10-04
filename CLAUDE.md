# CLAUDE.md

## Project Overview

Homebridge AI Kit (`@mp-consulting/homebridge-ai-kit`, renamed from `homebridge-mcp-server`) — the home for all MP Consulting Homebridge AI code. It contains: a Model Context Protocol server (stdio + Streamable HTTP) that bridges AI assistants with Homebridge; the Assistant core (provider adapters over plain `fetch`, an agent loop that drives the MCP tools in-process, and ready-made features); and a Homebridge platform plugin (`HomebridgeAiKit`) with a custom settings UI. Package exports: `.` (AI core + Homebridge plugin default export), `./mcp`, `./plugin`.

The repo is an npm workspace with two packages: the root is ai-kit, and `packages/ai-core` is `@mp-consulting/homebridge-ai-core` — everything that doesn't need MCP (config, redaction, prompts, tokens, json, usage, providers, features, plugin-UI routes), with `ajv` as its only runtime dependency. Homebridge plugins depend on ai-core; ai-kit depends on it (`^2.0.0`) and re-exports all of it from `.` and `./plugin`. Never import the MCP SDK, zod, socket.io-client or `@homebridge/plugin-ui-utils` from ai-core.

## Tech Stack

- **Language:** TypeScript (strict mode, ES2022, ESM via NodeNext)
- **Runtime:** Node.js `^22.10.0 || ^24.0.0 || ^26.0.0`
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **JSON Schema validation:** ajv · **Live updates:** socket.io-client · **TLS pinning:** undici · **Plugin UI:** `@homebridge/plugin-ui-utils`, `@mp-consulting/homebridge-ui-kit`
- **Validation:** Zod
- **Test framework:** Vitest
- **Build:** `tsc` (output to `dist/`)

## Project Structure

```
packages/ai-core/                # @mp-consulting/homebridge-ai-core (own package.json, tsconfig, vitest config, README, CHANGELOG)
├── src/
│   ├── index.ts                 # `.` — config, redaction, providers, features, utilities
│   ├── core/
│   │   ├── config.ts            # AiConfig, resolveAiConfig(), readAiConfig() — the HomebridgeAiKit block
│   │   ├── prompts.ts           # PROMPTS — feature templates + MCP prompt texts
│   │   ├── json.ts              # generateJson() (ajv + one repair retry), normalizePluginSchema()
│   │   ├── tokens.ts            # estimateTokens(), trimToContext(), inputBudget()
│   │   ├── usage.ts             # UsageTracker (per day / month, budgets), costOf(), price table, registerModelPrices()
│   │   ├── usage-store.ts       # JsonFileUsageStore — persists UsageTracker totals
│   │   ├── logs.ts              # stripAnsi(), tailLines(), readLogTail()
│   │   ├── confirm.ts           # withConfirmTimeout(), ConfirmationBroker — confirm callbacks for hosts
│   │   ├── rate-limit.ts        # SlidingWindowRateLimiter
│   │   ├── ttl-cache.ts         # TtlCache
│   │   └── redaction.ts         # redact / restore secrets in config.json, redactText(), redactPairing()
│   ├── providers/
│   │   ├── types.ts             # AiProvider, ChatRequest/Result/Chunk, ToolDefinition, ProviderError
│   │   ├── http.ts              # postJson() (retries with backoff on 408/429/5xx), SSE parser, shared helpers
│   │   ├── anthropic.ts         # Messages API (tool_use, SSE, thinking blocks replayed verbatim)
│   │   ├── openai.ts            # Chat Completions (also openai-compatible: Ollama, LM Studio)
│   │   ├── gemini.ts            # generateContent / streamGenerateContent, functionDeclarations
│   │   └── index.ts             # createProvider(), complete() (stream-or-chat helper)
│   ├── features/
│   │   └── index.ts             # diagnoseLogs, generatePluginConfig, explainDeviceError, assessPluginUpdate, …
│   └── plugin/
│       ├── index.ts             # `./plugin` export
│       └── routes.ts            # registerAiRoutes() for plugin-ui-utils servers (structural type), testAiConnection()
└── test/                        # core/, providers/ (helpers.ts: stubFetch, sseResponse, fakeProvider), features/, plugin/
src/                             # ai-kit; imports ai-core as `@mp-consulting/homebridge-ai-core`
├── index.ts                     # `.` — `export *` from ai-core + runAgent + `export default` Homebridge plugin initializer
├── bin/
│   ├── homebridge-ai-kit.ts     # CLI — `homebridge-ai-kit mcp [--http --port --host]`
│   └── homebridge-mcp-server.ts # Alias kept for configs written for the old package name
├── agent/
│   └── run-agent.ts             # runAgent() — provider ↔ in-memory MCP client loop, confirm for destructive tools, untrusted-data wrapping, optional audit
├── plugin/
│   ├── index.ts                 # `./plugin` export — re-exports ai-core's routes + its own
│   ├── platform.ts              # AiKitPlatform — logs status, optionally runs the HTTP MCP server
│   └── snippets.ts              # mcpClientSnippets() for Claude Desktop / Claude Code / Cursor
└── mcp/
    ├── index.ts                 # `./mcp` export
    ├── stdio.ts                 # runStdioServer() / runHttpFromEnv() — env wiring for the CLI
    ├── http.ts                  # runHttpServer() — Streamable HTTP, scoped bearer tokens, Origin check, session TTL/cap, 401 backoff
    ├── create-server.ts         # createServer(client, { readOnly, scope, allowSecrets, audit, elicitation, live }) — tools, resources, prompts
    ├── elicitation.ts           # withElicitation() — destructive tools ask the user through MCP elicitation
    ├── accessory-select.ts      # list_accessories filters, selectAccessories(), isSecurityWrite() (locks / doors / alarms)
    ├── config-diff.ts           # diffJson(), unifiedJsonDiff() for config dryRun previews
    ├── log-parse.ts             # parse log lines (time, level from colour, plugin prefix), parseTimeBound()
    ├── homebridge-client.ts     # HTTP client for the Homebridge UI REST API (login, API token or getToken)
    ├── tls.ts                   # createTrustedFetch() — undici fetch trusting a pinned fingerprint / PEM (self-signed https UI)
    ├── live.ts                  # createLiveSource() — socket.io change feed with polling fallback; shareLiveSource()
    ├── audit.ts                 # createAuditLog() — JSONL audit log of write tool calls, rotated by size
    ├── scopes.ts                # token scopes read < control < admin
    ├── resources.ts             # homebridge:// resources + resources/subscribe
    ├── resource-templates.ts    # homebridge://accessory/{uniqueId}, plugin/{name}, child-bridge/{id}
    ├── prompts.ts               # MCP prompts (text from ai-core's PROMPTS)
    ├── regex-search.ts          # regex log search in a killable worker thread
    ├── types.ts                 # RegisterTools signature + Homebridge API shapes
    └── tools/
        ├── helpers.ts           # registrar (scope filter + audit), result helpers (structuredResult, untrusted), handle(), pick()
        ├── output-schemas.ts    # outputSchema shapes for structured tool results
        ├── accessories.ts       # list, get, set / set_security_accessory (value checked vs metadata), room layout
        ├── bulk.ts              # set_accessories — one characteristic on many accessories, dryRun, maxTargets
        ├── scenes.ts            # list_scenes, run_scene, save_scene (Glass UI)
        ├── notifications.ts     # send_test_notification (Glass UI)
        ├── config-backups.ts    # list_config_backups, restore_config, create_backup, list_backups
        ├── history.ts           # get_accessory_history — Glass UI sensor history, summarized + downsampled
        ├── server.ts            # status, restart, pairing, cached accessories
        ├── child-bridges.ts     # list / health / restart / stop / start child bridges
        ├── config.ts            # get / update / patch config.json (dryRun diffs)
        ├── plugins.ts           # list, search, lookup, versions, changelog
        ├── plugin-jobs.ts       # install / update / uninstall (Glass UI jobs, polled), get_plugin_job
        ├── system.ts            # system info (CPU, memory, OS)
        └── logs.ts              # recent logs, search logs (since/until, level, plugin, context)
config.schema.json               # Homebridge plugin schema (pluginAlias HomebridgeAiKit, customUi)
homebridge-ui/
├── server.js                    # custom UI server: registerAiRoutes + /ai/test, /mcp/token, /mcp/snippets
└── public/                      # settings page (js/theme.js, js/app.js, css/app.css); lib/ is copied from homebridge-ui-kit at build (gitignored)
```

Tests mirror the source structure under `test/` (ai-kit) and `packages/ai-core/test/` (ai-core); shared MCP mocks live in `test/mcp/helpers.ts`, and `packages/ai-core/test/providers/helpers.ts` has `stubFetch()`, `sseResponse()` and `fakeProvider()`. ai-kit's vitest config aliases `@mp-consulting/homebridge-ai-core` to ai-core's sources, so its tests need no build; `tsc` (typecheck/build) uses ai-core's `dist`, so root `typecheck` and `build` build ai-core first. Both packages enforce coverage thresholds 95/90/95/95.

## Commands

- Root scripts cover both packages (ai-core first); `npm run <script> -w packages/ai-core` runs one for ai-core only.
- `npm run build` — build ai-core, copy ui-kit assets into `homebridge-ui/public/lib` (`mp-ui-kit-copy --vendor`), then compile TypeScript
- `npm run dev` — run the MCP server with tsx
- `npm test` — run tests (vitest run)
- `npm run test:watch` — run tests in watch mode
- `npm run test:coverage` — tests with coverage thresholds (CI runs this)
- `npm run lint` — ESLint, zero warnings allowed
- `npm run typecheck` — type-check `src` and `test` (plain `tsc` only covers `src`)

## Architecture Patterns

- Each `tools/*.ts` file exports `register: RegisterTools`, a `(tool, client)` function. `tool` is the registrar from `createRegistrar()`, a thin wrapper over `McpServer.registerTool` that skips non-read-only tools in read-only mode.
- Every tool must declare `title`, `description` and `annotations` (with `readOnlyHint`; write tools also set `destructiveHint`). Use the `READ` / `READ_REGISTRY` presets for read-only tools. Write tools need the `admin` token scope unless they set `scope: 'control'` (everyday device control).
- Writes that unlock, open or disarm something (`isSecurityWrite()` in `accessory-select.ts`) go through the destructive `set_security_accessory`; every other write tool refuses or skips them.
- Homebridge-sourced free text (logs, changelogs) is returned through `untrusted()` / `untrustedResult()`; `runAgent` wraps every tool result it sends to the model.
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
- `HOMEBRIDGE_AI_MCP_TOKEN` — bearer token required by `mcp --http` (scope `admin`, or `read` when read-only)
- `HOMEBRIDGE_AI_MCP_TOKENS` — optional; more `--http` tokens as `scope:token` pairs (`read` / `control` / `admin`), comma-separated
- `HOMEBRIDGE_AI_MCP_ALLOWED_ORIGINS`, `HOMEBRIDGE_AI_MCP_MAX_SESSIONS`, `HOMEBRIDGE_AI_MCP_SESSION_IDLE_MINUTES` — optional `--http` limits
- `HOMEBRIDGE_AI_AUDIT_LOG` — optional; JSONL audit log path for write tool calls
- `HOMEBRIDGE_READ_ONLY` — optional; `true` registers only read-only tools
- `HOMEBRIDGE_ALLOW_SECRETS` — optional; `true` lets `get_config` return real secrets (`includeSecrets`), never in read-only mode
- `HOMEBRIDGE_ELICITATION` — optional; `false` stops destructive tools asking the user through MCP elicitation (default on)
- `HOMEBRIDGE_TIMEOUT_MS` — optional; request timeout (default 30000)
- `HOMEBRIDGE_CERT_FINGERPRINT` — optional; SHA-256 fingerprint of an https Homebridge UI's (self-signed) certificate to trust, pinned (plugin: `mcp.http.homebridgeCertFingerprint`)
- `HOMEBRIDGE_CERT_PATH` — optional; PEM with the https Homebridge UI's certificate or CA to trust (plugin: `mcp.http.homebridgeCertPath`)

## Key Conventions

- All API calls go through `HomebridgeClient.fetchAuthed()` / `request()`, which handle auth, retries and timeouts.
- Tool inputs are validated with Zod schemas in each tool's `inputSchema`. Validation runs inside `McpServer`, so test it through `createServer` (see `test/mcp/create-server.test.ts`), not by calling handlers directly.
- Never put user-supplied regexes on the main thread; use `regexSearch()`.
- Never disable TLS verification (`NODE_TLS_REJECT_UNAUTHORIZED`, `rejectUnauthorized: false` on a shared agent). Trust a self-signed Homebridge UI through `createTrustedFetch()`, which only HomebridgeClient uses.
- Every field the code reads from the `HomebridgeAiKit` block must be in `config.schema.json` (the Homebridge UI drops unknown fields when it saves the form; `test/plugin/config-schema.test.ts` checks it), and the custom settings page must keep fields it doesn't show.
- Anything that returns `config.json` must go through `redactSecrets()` unless the caller explicitly asked for secrets.
- Room filtering in `list_accessories` uses the Homebridge UI layout (`/api/accessories/layout`), not HomeKit rooms.
- Tests use `vi.fn()`, `vi.stubGlobal()` and `vi.stubEnv()` for mocking — no real API or LLM calls in tests (providers are tested with a stubbed `fetch`). Use `mockClient()` / `collectHandlers()` from `test/mcp/helpers.ts`.
- **Always keep `README.md` and `CHANGELOG.md` up to date** when adding features, fixing bugs, or making any notable change.
- **Follow [Semantic Versioning](https://semver.org/)** — bump MAJOR for breaking changes, MINOR for new features, PATCH for bug fixes.
- **Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)** format in `CHANGELOG.md` — use Added, Changed, Deprecated, Removed, Fixed, Security sections.
- **Write clear commit messages** — concise subject line describing the "why", not just the "what".
