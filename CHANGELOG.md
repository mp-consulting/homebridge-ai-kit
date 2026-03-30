# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
