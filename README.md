# @mp-consulting/homebridge-ai-kit

AI toolkit for [Homebridge](https://homebridge.io), in one package:

- **An MCP server** that lets AI assistants (Claude Desktop, Claude Code, Cursor) control accessories, manage plugins, edit configuration and read logs, over stdio or Streamable HTTP.
- **The Assistant**: provider adapters (Claude, OpenAI, Gemini, any OpenAI-compatible server), an agent loop wired to the MCP tools, and ready-made features (log doctor, config copilot, device-error explainer, update-risk briefing, organiser, daily digest). Homebridge Glass UI and the MP Consulting plugins use these.
- **A Homebridge plugin** (`HomebridgeAiKit` platform) with a settings page to pick the provider and model, test the connection, serve MCP over HTTP and generate client configs.

The AI building blocks that don't need MCP also ship on their own as [`@mp-consulting/homebridge-ai-core`](packages/ai-core) — see [Packages](#packages).

> **Renamed from `@mp-consulting/homebridge-mcp-server`.** The old `homebridge-mcp-server` command still works, so existing MCP client configs don't need to change. See [Migrating from homebridge-mcp-server](#migrating-from-homebridge-mcp-server).

## Contents

- [Packages](#packages)
- [Features](#features)
- [Providers](#providers)
- [Homebridge plugin](#homebridge-plugin) · [MCP tokens](#mcp-tokens)
- [MCP server](#mcp-server)
- [Library API](#library-api)
- [Security](#security)
- [Migrating from homebridge-mcp-server](#migrating-from-homebridge-mcp-server)
- [Development](#development)

## Packages

This repository is an npm workspace that publishes two packages, both at version 2.0.0:

| Package | Use it for | Runtime dependencies |
|---|---|---|
| [`@mp-consulting/homebridge-ai-core`](packages/ai-core) | **Homebridge plugins.** The plugin-UI Assistant routes (`registerAiRoutes` from `./plugin`), providers, redaction, prompts, config and the Assistant features (everything except `runAgent`). | `ajv` only |
| `@mp-consulting/homebridge-ai-kit` (this package) | **Homebridge Glass UI and MCP.** Everything in ai-core (re-exported) plus the MCP server, `runAgent`, the `HomebridgeAiKit` Homebridge plugin and `mcpClientSnippets`. | ai-core, `@modelcontextprotocol/sdk`, `socket.io-client`, `zod`, `undici`, `@homebridge/plugin-ui-utils` |

Plugins should depend on **ai-core**, so installing them doesn't pull in the MCP SDK, socket.io or zod. ai-kit stays backward compatible: its `.` and `./plugin` exports re-export everything ai-core has under the same names, so code that imports from ai-kit keeps working.

## Features

**MCP tools** (32): accessories (list, get, control with value checks, room layout, sensor history), server (status, restart, pairing, cached accessories), child bridges (list, restart, stop, start), config (read with secrets redacted, full write, partial `patch_config`), plugins (list, search, versions, schema, changelog, install, update, uninstall), system info and logs (recent lines, regex search).

**MCP resources** you can subscribe to: `homebridge://accessories`, `homebridge://logs/recent`, `homebridge://status`. Changes arrive over the Homebridge UI's socket.io namespaces, or by polling when the socket can't be used.

**MCP prompts**: `diagnose-logs`, `plan-upgrade`, `audit-config`.

**Assistant features** (library): `diagnoseLogs`, `generatePluginConfig`, `explainDeviceError`, `assessPluginUpdate`, `suggestOrganization`, `dailyDigest`, `ask`, and `runAgent` for anything that needs the tools. Every input is redacted before it reaches a provider and trimmed to fit its context window; JSON outputs are checked against a schema with one automatic repair attempt; token usage and Claude costs are tracked.

## Providers

All providers use plain `fetch` (no SDKs). Each declares what it can do, and features without tool calling fall back to prompt-only answers.

| `provider` | Default model | API key | Tools | Streaming | Context |
|---|---|---|---|---|---|
| `anthropic` | `claude-sonnet-5-5` | required | yes | yes | 1M (200K for Haiku) |
| `openai` | `gpt-5` | required | yes | yes | 128K |
| `gemini` | `gemini-3.8-flash` | required | yes | yes | 1M |
| `openai-compatible` | `llama3.1` | optional | yes | yes | 8K (set `contextTokens`) |

- Claude models: `claude-sonnet-5-5` (default), `claude-haiku-4-5-20251001` (cheapest), `claude-opus-5-5` (most capable).
- `openai-compatible` works with Ollama (`http://127.0.0.1:11434/v1`, the default), LM Studio (`http://127.0.0.1:1234/v1`), vLLM and similar. Set `contextTokens` to your model's context window so inputs are trimmed correctly.
- An on-device Apple Foundation Models provider is planned.

## Homebridge plugin

Install it like any plugin (Homebridge 1.8+ or 2.x):

```bash
npm install -g @mp-consulting/homebridge-ai-kit
```

Then open its settings in the Homebridge UI. The settings page edits the `HomebridgeAiKit` platform block, tests the connection with the values in the form, and shows ready-to-paste configs for Claude Desktop, Claude Code and Cursor.

```jsonc
{
  "platform": "HomebridgeAiKit",
  "name": "AI Kit",
  "enabled": true,
  "provider": "anthropic",            // anthropic | openai | gemini | openai-compatible
  "model": "claude-sonnet-5-5",       // optional, defaults per provider
  "apiKey": "sk-ant-…",               // secret, redacted wherever config is shown to a model
  "baseUrl": "http://127.0.0.1:11434/v1", // openai-compatible only (or a proxy)
  "contextTokens": 32768,             // optional override, mainly for local models
  "maxOutputTokens": 2048,
  "effort": "medium",                 // Claude only: low | medium | high | xhigh | max (unset = model default)
  "maxRetries": 2,                    // retries on 408/429/5xx/529 and network errors (backoff, honours retry-after); 0 = off
  "mcp": {
    "http": {
      "enabled": false,
      "host": "127.0.0.1",
      "port": 8582,
      "token": "…",                   // bearer token MCP clients must send
      "homebridgeUrl": "http://127.0.0.1:8581",
      "homebridgeToken": "hbg_…",     // Glass UI API token the tools act with
      "homebridgeTokenId": "…",       // written by Glass UI so it can revoke that token; leave as is
      "homebridgeCertFingerprint": "AB:CD:…", // https UI with a self-signed certificate: its SHA-256 fingerprint
      "homebridgeCertPath": "/path/to/certificate.pem" // or a PEM with the UI's certificate or its CA
    }
  }
}
```

With `mcp.http.enabled`, the plugin serves MCP at `http://<host>:<port>/mcp` while Homebridge runs. It needs a client token (`mcp.http.token` or `HOMEBRIDGE_AI_MCP_TOKEN`) and Homebridge credentials: a Glass UI API token in `homebridgeToken`, or the `HOMEBRIDGE_*` environment variables. A read-only API token gives clients read-only access.

### MCP tokens

The MCP server uses two different tokens:

| Token | What it is for | Stored in |
|---|---|---|
| **Client token** | What Claude, Cursor or another MCP client must send (`Authorization: Bearer …`) to reach the HTTP MCP server | `mcp.http.token` (or `HOMEBRIDGE_AI_MCP_TOKEN` for the CLI) |
| **Homebridge API token** | What the MCP server sends to the Homebridge UI to run its tools. Its scope decides what clients can do: `read` gives read-only tools, `admin` gives all of them | `mcp.http.homebridgeToken` (or `HOMEBRIDGE_TOKEN` for the CLI) |

Where to set or generate them:

- **Homebridge Glass UI 2.0.0-beta.6 or later:** *Settings → Assistant → MCP server* generates the client token, creates the Homebridge API token in one click (read-only or admin, revoked again when you replace or remove it), and shows the client configs. Each secret is shown once; after that the page only says whether one is set.
- **This plugin's settings page:** *Generate* creates a client token. Paste a Homebridge API token created in Glass UI under *Users → API Tokens*.
- **The CLI:** set `HOMEBRIDGE_AI_MCP_TOKEN` and `HOMEBRIDGE_TOKEN` (see [MCP server](#mcp-server)), e.g. `HOMEBRIDGE_AI_MCP_TOKEN=$(openssl rand -base64 24)`.

Glass UI also stores `homebridgeTokenId`, the id of the API token it created, so it can revoke the token when you replace or remove it. The settings page keeps it (and any other field it doesn't show) when it saves.

#### Homebridge UI over HTTPS with a self-signed certificate

Node refuses a self-signed certificate, so the MCP server can't reach a Homebridge UI served that way until you tell it which certificate to trust. Verification is never turned off: the setting only applies to the server's requests to the Homebridge UI.

| Setting | CLI | What it trusts |
|---|---|---|
| `mcp.http.homebridgeCertFingerprint` | `HOMEBRIDGE_CERT_FINGERPRINT` | Exactly the certificate with this SHA-256 fingerprint (pinned). Any other certificate, even a valid one, is refused with an error that shows both fingerprints. |
| `mcp.http.homebridgeCertPath` | `HOMEBRIDGE_CERT_PATH` | The certificates in this PEM file, on top of the public CAs: the UI's own self-signed certificate (accepted under any host name, e.g. `127.0.0.1`) or the CA that issued it (with the normal host name check). |

Get the fingerprint on the Homebridge machine with `openssl x509 -noout -fingerprint -sha256 -in <certificate.pem>` (Glass UI's self-signed certificate is `<storage>/ssl-certs/certificate.pem`); colons and case don't matter. Setting both requires the chain to validate against the PEM and the certificate to match the fingerprint. Update the fingerprint when the certificate is renewed. Both only apply to an `https` URL. Resource subscriptions then follow changes by polling, since the socket.io connection keeps Node's default verification.

Changes to `mcp.http` apply after a Homebridge restart, since the plugin starts the HTTP server when Homebridge loads it. Treat both tokens like passwords: anyone with the client token can use every tool the Homebridge API token allows.

### Assistant routes for other plugins

A plugin's custom UI server can offer the Assistant with one call. Import the routes from `@mp-consulting/homebridge-ai-core/plugin` (ai-kit's `./plugin` re-exports them, but plugins should depend on the slimmer ai-core). The browser side is `MpKit.ai` from [`@mp-consulting/homebridge-ui-kit`](https://github.com/mp-consulting/homebridge-ui-kit):

```js
// homebridge-ui/server.js
import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { registerAiRoutes } from '@mp-consulting/homebridge-ai-core/plugin';

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    registerAiRoutes(this, { pluginName: '@mp-consulting/homebridge-ewelink' });
    this.ready();
  }
}
new UiServer();
```

| Route | Body | Result |
|---|---|---|
| `/ai/status` | none | `{ enabled, provider, model, capabilities }` (never the key) |
| `/ai/explain` | `{ error, context?, device?, requestId? }` | `{ text, usage }` |
| `/ai/ask` | `{ prompt, context?, requestId? }` | `{ text, usage }` |
| `/ai/config` | `{ schema, request, current?, requestId? }` | `{ config, explanation, usage }` |

With a `requestId`, the server streams `ai:chunk` `{ requestId, delta }` events, then `ai:done` `{ requestId }` or `ai:error` `{ requestId, message }`. The routes read the `HomebridgeAiKit` block from config.json on every request, so settings changes apply at once.

## MCP server

### Environment

| Variable | Description |
|----------|-------------|
| `HOMEBRIDGE_URL` | URL of your Homebridge UI, e.g. `http://192.168.1.100:8581` (required) |
| `HOMEBRIDGE_TOKEN` | A Homebridge UI API token (Glass UI `hbg_…`). Replaces username and password |
| `HOMEBRIDGE_USERNAME` / `HOMEBRIDGE_PASSWORD` | UI login, when no token is set |
| `HOMEBRIDGE_READ_ONLY` | `true` removes every tool that changes something |
| `HOMEBRIDGE_TIMEOUT_MS` | Request timeout (default `30000`) |
| `HOMEBRIDGE_CERT_FINGERPRINT` | SHA-256 fingerprint of an `https` Homebridge UI's self-signed certificate to trust (pinned). See [self-signed certificates](#homebridge-ui-over-https-with-a-self-signed-certificate) |
| `HOMEBRIDGE_CERT_PATH` | PEM file with the `https` Homebridge UI's certificate or its CA to trust |
| `HOMEBRIDGE_AI_MCP_TOKEN` | Bearer token required by `--http` |

### stdio (Claude Desktop, Claude Code, Cursor)

```json
{
  "mcpServers": {
    "homebridge": {
      "command": "npx",
      "args": ["-y", "@mp-consulting/homebridge-ai-kit", "mcp"],
      "env": {
        "HOMEBRIDGE_URL": "http://192.168.1.100:8581",
        "HOMEBRIDGE_TOKEN": "hbg_…"
      }
    }
  }
}
```

```bash
claude mcp add homebridge -e HOMEBRIDGE_URL=http://192.168.1.100:8581 -e HOMEBRIDGE_TOKEN=hbg_… -- npx -y @mp-consulting/homebridge-ai-kit mcp
```

### Streamable HTTP

```bash
HOMEBRIDGE_AI_MCP_TOKEN=$(openssl rand -base64 24) \
HOMEBRIDGE_URL=http://127.0.0.1:8581 HOMEBRIDGE_TOKEN=hbg_… \
homebridge-ai-kit mcp --http --port 8582 --host 127.0.0.1
```

The endpoint is `http://127.0.0.1:8582/mcp`. Every request needs `Authorization: Bearer <HOMEBRIDGE_AI_MCP_TOKEN>`. It binds to `127.0.0.1` by default; only use `--host 0.0.0.0` on a trusted network, ideally behind HTTPS.

```bash
claude mcp add --transport http homebridge http://127.0.0.1:8582/mcp --header "Authorization: Bearer <token>"
```

### Tools

| Group | Tools |
|---|---|
| Accessories | `list_accessories` (filter by `room`, `type`, `name`, `manufacturer`, `excludeManufacturer`), `get_accessory`, `set_accessory`, `get_accessory_layout`, `get_accessory_history` |
| Server | `get_homebridge_status`, `get_server_status`, `restart_homebridge`, `get_pairing_info`, `get_cached_accessories`, `remove_cached_accessory`, `reset_cached_accessories` |
| Child bridges | `list_child_bridges`, `restart_child_bridge`, `stop_child_bridge`, `start_child_bridge` |
| Config | `get_config`, `update_config`, `patch_config` |
| Plugins | `list_plugins`, `search_plugins`, `lookup_plugin`, `get_plugin_versions`, `get_plugin_config_schema`, `get_plugin_changelog`, `install_plugin`, `update_plugin`, `uninstall_plugin`, `get_plugin_job` |
| System | `get_system_info` |
| Logs | `get_recent_logs`, `search_logs` |

- `set_accessory` checks the value against the characteristic first (format, min/max, step, valid values, write permission), coerces `"50"` to `50` or `1` to `true`, and explains what is wrong instead of sending a bad value.
- `get_accessory_history` returns an accessory's recorded sensor values (temperature, humidity, light level, battery, air quality, power, energy) over the last `hours` (default 24, up to 8760), optionally for one characteristic `type`. Per series it gives `count`, `min` / `max` (value and when), the time-weighted `avg`, `last`, and the `points` averaged down to `maxPoints` (default 48, 2–500), with times in UTC to the minute. It needs Homebridge Glass UI (`GET /api/accessories/:uniqueId/history`), which records these values while Homebridge runs in insecure mode.
- `patch_config` changes one platform or accessory block (found by `platform`/`accessory` plus `name`); objects merge, `null` removes a key, and `__REDACTED__` keeps the current secret.
- `install_plugin`, `update_plugin` and `uninstall_plugin` start a job on the Homebridge UI and wait up to two minutes for it; `get_plugin_job` follows a longer one. They need Homebridge Glass UI (`POST /api/plugins/install|update|uninstall`, `GET /api/plugins/jobs/:id`).
- The log tools need a Homebridge install managed by [hb-service](https://github.com/homebridge/homebridge-config-ui-x/wiki/Homebridge-Service-Command).

## Library API

```js
import {
  createProvider, readAiConfig, runAgent, diagnoseLogs, generatePluginConfig, UsageTracker,
} from '@mp-consulting/homebridge-ai-kit';
import { HomebridgeClient } from '@mp-consulting/homebridge-ai-kit/mcp';

const config = await readAiConfig();            // HomebridgeAiKit block of ~/.homebridge/config.json
const provider = createProvider(config);

// One-shot feature, streamed
const { text } = await diagnoseLogs({ provider, logs, onChunk: (d) => process.stdout.write(d) });

// Agent with the MCP tools, acting as the current user
const client = new HomebridgeClient({ url: 'http://127.0.0.1:8581', getToken: () => mintShortLivedToken(user) });
const result = await runAgent({
  provider,
  client,
  messages: [{ role: 'user', content: 'Turn off every light downstairs' }],
  confirm: async (call) => askUser(`Allow ${call.name}?`), // destructive tools are refused without it
  onEvent: (e) => console.log(e),
});
```

| Export | Purpose |
|---|---|
| `createProvider(config)` → `AiProvider` | `chat(req)` and `stream(req)` with `ChatRequest { system?, messages, tools?, maxOutputTokens?, signal? }` |
| `runAgent(opts)` → `AgentResult` | Loops model ↔ MCP tools (in-memory transport), `maxSteps` 8 by default, `readOnly`, `confirm` for destructive tools |
| `diagnoseLogs`, `generatePluginConfig`, `explainDeviceError`, `assessPluginUpdate`, `suggestOrganization`, `dailyDigest`, `ask` | Ready-made features; all accept `onChunk`, `signal`, `systemContext` |
| `generateJson({ provider, schema, prompt })` | Schema-checked JSON (ajv) with one repair retry |
| `trimToContext`, `estimateTokens` | Keep inputs inside the context window (logs keep their tail) |
| `UsageTracker`, `costOf` | Token and cost accounting (Claude prices; unknown models cost `null`) |
| `PROMPTS` | Prompt templates, shared with the MCP prompts |
| `readAiConfig`, `resolveAiConfig` | Read and default the `HomebridgeAiKit` block |
| `redactSecrets`, `restoreSecrets`, `redactText` | Keep credentials out of model context |

Everything in this table except `runAgent` comes from `@mp-consulting/homebridge-ai-core` and is re-exported here unchanged.

`./mcp` exports `createServer`, `HomebridgeClient`, `runStdioServer`, `runHttpServer`, `createLiveSource`; `./plugin` exports `registerAiRoutes` and `testAiConnection` (from ai-core's `./plugin`), `mcpClientSnippets` and `AiKitPlatform`.

## Security

- **Secrets stay out of the model's context.** `get_config`, `patch_config` and the Assistant features replace passwords, tokens, API keys (including the AI Kit `apiKey` and MCP tokens) and the bridge pin with `__REDACTED__`. Writes swap the placeholders back for the real values. Free text sent to a provider (logs, errors) has credential-shaped values masked too.
- **Destructive actions need consent.** Every tool declares MCP `readOnlyHint` / `destructiveHint`; `runAgent` refuses destructive tools unless a `confirm` callback allows them. `HOMEBRIDGE_READ_ONLY=true` removes write tools entirely.
- **HTTP is locked down.** The HTTP transport requires a bearer token, compares it in constant time and binds to `127.0.0.1` by default.
- **`update_config` rejects incomplete configs**, and regex log searches run in a worker thread that is killed after 5 seconds.
- The server warns if `HOMEBRIDGE_URL` sends credentials over plain `http` to a non-local host.
- **TLS verification stays on.** A self-signed Homebridge UI certificate is trusted only through `HOMEBRIDGE_CERT_FINGERPRINT` / `HOMEBRIDGE_CERT_PATH` (or the matching `mcp.http` settings), and only for the requests to the Homebridge UI; a certificate that doesn't match is refused.

## Migrating from homebridge-mcp-server

```bash
npm uninstall -g @mp-consulting/homebridge-mcp-server
npm install -g @mp-consulting/homebridge-ai-kit
```

The package installs both `homebridge-ai-kit` and a `homebridge-mcp-server` alias, and the environment variables are unchanged, so existing configs keep working. New configs should use `homebridge-ai-kit mcp`. The MCP server now reports its name as `homebridge-ai-kit`, and library users import `createServer` and `HomebridgeClient` from `@mp-consulting/homebridge-ai-kit/mcp`.

## Development

```bash
git clone https://github.com/mp-consulting/homebridge-ai-kit.git
cd homebridge-ai-kit
npm install
npm run build          # builds packages/ai-core, copies the ui-kit assets into homebridge-ui/public/lib, then tsc
```

The repository is an npm workspace: the root is ai-kit and `packages/ai-core` is ai-core. The root scripts run both packages (ai-core first); `npm run <script> -w packages/ai-core` runs one script for ai-core alone. ai-kit's tests resolve `@mp-consulting/homebridge-ai-core` to its sources, while `typecheck` and `build` use ai-core's `dist`, so they build it first.

```bash
npm run dev            # MCP server on stdio with tsx
npm test               # Run tests
npm run test:coverage  # Tests with coverage thresholds (as CI does)
npm run lint           # ESLint
npm run typecheck      # Type-check src and test (both packages)
```

**Publishing.** The release workflow publishes `@mp-consulting/homebridge-ai-core` first (skipped if that version is already on npm), then `@mp-consulting/homebridge-ai-kit`, which depends on it. Both use npm trusted publishing (OIDC): before the first release, configure a trusted publisher on npmjs.com for the new `@mp-consulting/homebridge-ai-core` package name too (repository `mp-consulting/homebridge-ai-kit`, workflow `publish.yml`); if npm only lets you add one to an existing package, publish ai-core 2.0.0 once by hand from `packages/ai-core`. The first ai-core release has to go out before ai-kit 2.0.0 can be installed from npm.

## License

MIT
