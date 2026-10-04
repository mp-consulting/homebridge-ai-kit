# @mp-consulting/homebridge-ai-core

The slim AI core for [Homebridge](https://homebridge.io) plugins by MP Consulting: the Assistant's provider adapters, secret redaction, prompts, config reading, ready-made features and the plugin settings-UI routes. Its only runtime dependency is [`ajv`](https://ajv.js.org).

It is split out of [`@mp-consulting/homebridge-ai-kit`](../../README.md), which re-exports all of it and adds the MCP server, the agent loop (`runAgent`) and the `HomebridgeAiKit` Homebridge plugin. Plugins should depend on ai-core so they don't install the MCP SDK, socket.io or zod; use ai-kit when you need MCP (Homebridge Glass UI, MCP clients).

The provider and model come from the `HomebridgeAiKit` platform block in Homebridge's `config.json`, which users set up with the AI Kit plugin's settings page.

## Install

```bash
npm install @mp-consulting/homebridge-ai-core
```

Requires Node.js `^22.10.0 || ^24.0.0 || ^26.0.0`. ESM only.

## Assistant routes for a plugin's settings UI

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

`registerAiRoutes(server, options?)` takes anything shaped like `HomebridgePluginUiServer` (`onRequest`, `pushEvent`, `homebridgeConfigPath`), so `@homebridge/plugin-ui-utils` is not a dependency of this package. Options: `pluginName`, `systemContext`, and for tests `loadConfig` and `createProvider`.

| Route | Body | Result |
|---|---|---|
| `/ai/status` | none | `{ enabled, provider, model, capabilities }` (never the key) |
| `/ai/explain` | `{ error, context?, device?, requestId? }` | `{ text, usage }` |
| `/ai/ask` | `{ prompt, context?, requestId? }` | `{ text, usage }` |
| `/ai/config` | `{ schema, request, current?, requestId? }` | `{ config, explanation, usage }` |

With a `requestId`, the server streams `ai:chunk` `{ requestId, delta }` events, then `ai:done` `{ requestId }` or `ai:error` `{ requestId, message }`. The config is re-read on every request, so settings changes apply at once. Inputs are redacted before they reach a provider.

## Exports

**`@mp-consulting/homebridge-ai-core`**

| Export | Purpose |
|---|---|
| `createProvider(config)` → `AiProvider`, `complete()`, `AnthropicProvider`, `OpenAiProvider`, `GeminiProvider`, `ProviderError` | Claude, OpenAI, Gemini and OpenAI-compatible servers (Ollama, LM Studio) over plain `fetch`, with `chat()` / `stream()` and tool calling. Requests are retried on network errors and 408 / 429 / 5xx / 529 with jittered exponential backoff, honouring `retry-after` (config `maxRetries`, default 2; `retry` option for the timings). Claude requests use prompt caching (tools, system prompt, conversation) and the config's `effort` |
| `DEFAULT_RETRY`, `isRetryableStatus`, `parseRetryAfter`, `backoffDelay`, `RetryOptions` | The retry policy, for callers with their own HTTP |
| `diagnoseLogs`, `generatePluginConfig`, `explainDeviceError`, `assessPluginUpdate`, `suggestOrganization`, `dailyDigest`, `ask` | Ready-made features; all accept `onChunk`, `signal`, `systemContext` |
| `readAiConfig`, `resolveAiConfig`, `findAiBlock`, `defaultConfigPath`, `PLATFORM_NAME`, `PLUGIN_NAME`, `PROVIDER_NAMES`, `DEFAULT_MODELS` (+ other `DEFAULT_*` constants) | Read and default the `HomebridgeAiKit` block |
| `redactSecrets`, `restoreSecrets`, `redactText`, `containsRedacted`, `isSecretKey`, `REDACTED`, `SecretRestoreError` | Keep credentials out of model context |
| `generateJson`, `extractJson`, `normalizePluginSchema`, `JsonGenerationError` | Schema-checked JSON (ajv) with one repair retry |
| `trimToContext`, `estimateTokens`, `inputBudget` | Keep inputs inside the context window |
| `UsageTracker`, `costOf`, `priceOf`, `registerModelPrices`, `addUsage`, `ZERO_USAGE`, `MODEL_PRICES` | Token and cost accounting; Claude prompt-cache reads and writes are priced at the cache rates; register OpenAI / Gemini prices with `registerModelPrices` (cached input reported as `cacheReadTokens`) |
| `PROMPTS` | Prompt templates (also used by ai-kit's MCP prompts) |

**`@mp-consulting/homebridge-ai-core/plugin`**: `registerAiRoutes`, `testAiConnection`, `PLATFORM_NAME`, `PLUGIN_NAME`, and the types `AiRoutesOptions`, `ConnectionTest`, `PluginUiServer`.

## Development

This package lives in `packages/ai-core` of the [homebridge-ai-kit](https://github.com/mp-consulting/homebridge-ai-kit) workspace. From the repository root, `npm run build`, `npm test`, `npm run lint` and `npm run typecheck` cover both packages; `npm run <script> -w packages/ai-core` runs one for ai-core alone. Tests stub `fetch`, so no real provider is called.

## License

MIT
