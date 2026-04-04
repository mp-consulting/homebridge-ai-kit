# CLAUDE.md

## Project Overview

Homebridge MCP Server — a Model Context Protocol server that bridges AI assistants (Claude) with Homebridge to control smart home accessories, manage plugins, and monitor the Homebridge instance.

## Tech Stack

- **Language:** TypeScript (strict mode, ES2022, ESM via NodeNext)
- **Runtime:** Node.js >= 18
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Validation:** Zod
- **Test framework:** Vitest
- **Build:** `tsc` (output to `dist/`)

## Project Structure

```
src/
├── index.ts                 # Entry point — MCP server bootstrap
├── homebridge-client.ts     # HTTP client for Homebridge REST API (JWT auth)
├── types.ts                 # Shared types (RegisterTools signature)
└── tools/
    ├── accessories.ts       # list, get, set accessories + room layout
    ├── server.ts            # status, restart, pairing, cached accessories
    ├── config.ts            # read/update config.json
    ├── plugins.ts           # list, search, lookup, versions, changelog
    └── system.ts            # system info (CPU, memory, OS)
```

Tests mirror the source structure under `src/__tests__/`.

## Commands

- `npm run build` — compile TypeScript
- `npm run dev` — run with tsx (hot reload)
- `npm test` — run tests (vitest run)
- `npm run test:watch` — run tests in watch mode

## Architecture Patterns

- Each `tools/*.ts` file exports a `register(server, client)` function that registers MCP tools on the server instance.
- `HomebridgeClient` handles all HTTP communication with the Homebridge REST API, including JWT auth with automatic token refresh.
- The server uses stdio transport (`StdioServerTransport`).
- **Custom UI**: Uses Homebridge custom UI framework (`homebridge-ui/`) for plugin configuration management

## Environment Variables

- `HOMEBRIDGE_URL` — Homebridge instance URL (e.g. `http://192.168.2.200:8581`)
- `HOMEBRIDGE_USERNAME` — login username
- `HOMEBRIDGE_PASSWORD` — login password

## Key Conventions

- All API calls go through `HomebridgeClient.request()` which handles auth and retries.
- Tool inputs are validated with Zod schemas inline in `server.tool()` calls.
- Room filtering in `list_accessories` uses the Homebridge UI layout (`/api/accessories/layout`), not HomeKit rooms.
- Tests use `vi.fn()` and `vi.stubGlobal()` for mocking — no real API calls in tests.
- **Always keep `README.md` and `CHANGELOG.md` up to date** when adding features, fixing bugs, or making any notable change.
- **Follow [Semantic Versioning](https://semver.org/)** — bump MAJOR for breaking changes, MINOR for new features, PATCH for bug fixes.
- **Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)** format in `CHANGELOG.md` — use Added, Changed, Deprecated, Removed, Fixed, Security sections.
- **Write clear commit messages** — concise subject line describing the "why", not just the "what".
