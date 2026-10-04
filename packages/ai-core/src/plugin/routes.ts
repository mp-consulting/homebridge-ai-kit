/**
 * Assistant routes for a plugin's custom settings UI (`homebridge-ui/server.js`).
 * The browser side (ui-kit's `MpKit.ai`) calls them with `homebridge.request()`;
 * the provider key stays on the server.
 */

import type { AiConfig } from '../core/config.js';
import { readAiConfig, resolveAiConfig } from '../core/config.js';
import { redactText } from '../core/redaction.js';
import { ask, explainDeviceError, generatePluginConfig } from '../features/index.js';
import { createProvider } from '../providers/index.js';
import type { AiProvider } from '../providers/types.js';

/** The part of `@homebridge/plugin-ui-utils`' `HomebridgePluginUiServer` the routes use. */
export interface PluginUiServer {
  onRequest(path: string, fn: (body: any) => unknown): void; // eslint-disable-line @typescript-eslint/no-explicit-any
  pushEvent(event: string, data: unknown): void;
  readonly homebridgeConfigPath?: string;
}

export interface AiRoutesOptions {
  /** e.g. `@mp-consulting/homebridge-ewelink`; tells the model which plugin it is helping with. */
  pluginName?: string;
  /** Extra system-prompt context about the plugin or its devices. */
  systemContext?: string;
  /** Where the config comes from. Default: the `HomebridgeAiKit` block of the server's config.json, re-read per request. */
  loadConfig?: () => Promise<AiConfig | null>;
  /** Provider factory (tests inject a fake). */
  createProvider?: (config: AiConfig) => AiProvider;
}

interface Streamable {
  requestId?: unknown;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body?.[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`"${key}" is required`);
  }
  return value;
}

export function registerAiRoutes(server: PluginUiServer, options: AiRoutesOptions = {}): void {
  const loadConfig = options.loadConfig ?? (() => readAiConfig(server.homebridgeConfigPath));
  const makeProvider = options.createProvider ?? createProvider;
  const systemContext =
    [options.pluginName && `The user is in the settings of the Homebridge plugin ${options.pluginName}.`, options.systemContext].filter(Boolean).join('\n') ||
    undefined;

  const provider = async (): Promise<AiProvider> => {
    const config = await loadConfig();
    if (!config || !config.enabled) {
      throw new Error('The Assistant is not set up. Add and enable the AI Kit (HomebridgeAiKit) platform in the Homebridge settings.');
    }
    return makeProvider(config);
  };

  /** Runs `fn`, streaming text as `ai:chunk` events when the body carries a requestId. */
  const streamed = async <T>(body: Streamable, fn: (onChunk?: (delta: string) => void) => Promise<T>): Promise<T> => {
    const requestId = typeof body?.requestId === 'string' ? body.requestId : undefined;
    const onChunk = requestId ? (delta: string) => server.pushEvent('ai:chunk', { requestId, delta }) : undefined;
    try {
      const result = await fn(onChunk);
      if (requestId) {
        server.pushEvent('ai:done', { requestId });
      }
      return result;
    } catch (error) {
      if (requestId) {
        server.pushEvent('ai:error', { requestId, message: (error as Error).message });
      }
      throw error;
    }
  };

  server.onRequest('/ai/status', async () => {
    const config = await loadConfig();
    if (!config) {
      return { enabled: false, provider: null, model: null, capabilities: null };
    }
    let capabilities = null;
    if (config.enabled) {
      try {
        capabilities = makeProvider(config).capabilities;
      } catch {
        // e.g. no API key yet: report the config, the UI shows it is not ready.
      }
    }
    return { enabled: config.enabled && capabilities !== null, provider: config.provider, model: config.model, capabilities };
  });

  server.onRequest('/ai/explain', (body) =>
    streamed(body, async (onChunk) => {
      const error = requireString(body, 'error');
      const { text, usage } = await explainDeviceError({
        provider: await provider(),
        error,
        context: typeof body.context === 'string' ? body.context : undefined,
        device: body.device,
        pluginName: options.pluginName,
        systemContext,
        onChunk,
      });
      return { text, usage };
    }),
  );

  server.onRequest('/ai/ask', (body) =>
    streamed(body, async (onChunk) => {
      const prompt = requireString(body, 'prompt');
      const { text, usage } = await ask({
        provider: await provider(),
        prompt,
        context: typeof body.context === 'string' ? body.context : undefined,
        systemContext,
        onChunk,
      });
      return { text, usage };
    }),
  );

  server.onRequest('/ai/config', (body) =>
    streamed(body, async (onChunk) => {
      const request = requireString(body, 'request');
      if (typeof body.schema !== 'object' || body.schema === null) {
        throw new Error('"schema" is required');
      }
      return generatePluginConfig({
        provider: await provider(),
        schema: body.schema,
        request,
        current: typeof body.current === 'object' && body.current !== null ? body.current : undefined,
        pluginName: options.pluginName,
        systemContext,
        onChunk,
      });
    }),
  );
}

export interface ConnectionTest {
  ok: boolean;
  provider?: string;
  model?: string;
  latencyMs?: number;
  reply?: string;
  message?: string;
}

/**
 * Sends a tiny prompt with an unsaved `HomebridgeAiKit` block (from the settings
 * form) to check the provider, model and key work. Never throws.
 */
export async function testAiConnection(block: unknown, factory: (config: AiConfig) => AiProvider = createProvider): Promise<ConnectionTest> {
  const started = Date.now();
  try {
    const config = resolveAiConfig(block);
    const provider = factory(config);
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      maxOutputTokens: 256,
      signal: AbortSignal.timeout(30_000),
    });
    return { ok: true, provider: config.provider, model: result.model, latencyMs: Date.now() - started, reply: result.text.slice(0, 200) };
  } catch (error) {
    // The message comes from the provider; make sure no key slipped in.
    return { ok: false, message: redactText((error as Error).message) };
  }
}
