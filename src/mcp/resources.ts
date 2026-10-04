import { tailLines } from '@mp-consulting/homebridge-ai-core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError, SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { HomebridgeClient } from './homebridge-client.js';
import type { LiveSource, LiveTopic, LiveWatch } from './live.js';

export const RESOURCE_URIS = {
  accessories: 'homebridge://accessories',
  logs: 'homebridge://logs/recent',
  status: 'homebridge://status',
} as const;

const TOPIC_BY_URI: Record<string, LiveTopic> = {
  [RESOURCE_URIS.accessories]: 'accessories',
  [RESOURCE_URIS.logs]: 'log',
  [RESOURCE_URIS.status]: 'status',
};

/** Lines of log returned by `homebridge://logs/recent`. */
export const RECENT_LOG_LINES = 200;

function json(uri: string, data: unknown) {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data) }] };
}

/**
 * Registers the live resources and, when `live` is given, `resources/subscribe`
 * support: each subscribed URI gets a watch that sends `notifications/resources/updated`.
 */
export function registerResources(server: McpServer, client: HomebridgeClient, live: LiveSource | false): void {
  server.registerResource(
    'accessories',
    RESOURCE_URIS.accessories,
    { title: 'Accessories', description: 'Every accessory with its current values. Subscribe to hear about changes.', mimeType: 'application/json' },
    async (uri) =>
      json(
        uri.href,
        (await client.getAccessories()).map((a) => ({ uniqueId: a.uniqueId, serviceName: a.serviceName, type: a.type, values: a.values ?? {} })),
      ),
  );

  server.registerResource(
    'recent-logs',
    RESOURCE_URIS.logs,
    { title: 'Recent log', description: `The last ${RECENT_LOG_LINES} Homebridge log lines. Subscribe to follow the log.`, mimeType: 'text/plain' },
    async (uri) => {
      const { text } = await client.getLogTail(64 * 1024);
      const lines = tailLines(text, RECENT_LOG_LINES, { keepBlank: true });
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: lines.join('\n') }] };
    },
  );

  server.registerResource(
    'status',
    RESOURCE_URIS.status,
    { title: 'Homebridge status', description: 'Whether Homebridge is up, and its child bridges. Subscribe to hear about changes.', mimeType: 'application/json' },
    async (uri) => {
      const [status, childBridges] = await Promise.all([client.getHomebridgeStatus(), client.getChildBridges().catch(() => undefined)]);
      return json(uri.href, { status, childBridges });
    },
  );

  if (!live) {
    return;
  }

  const watches = new Map<string, LiveWatch>();
  server.server.registerCapabilities({ resources: { subscribe: true } });

  server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
    const topic = TOPIC_BY_URI[params.uri];
    if (!topic) {
      throw new McpError(ErrorCode.InvalidParams, `Cannot subscribe to ${params.uri}`);
    }
    if (!watches.has(params.uri)) {
      watches.set(
        params.uri,
        live(topic, () => {
          server.server.sendResourceUpdated({ uri: params.uri }).catch(() => undefined);
        }),
      );
    }
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
    watches.get(params.uri)?.close();
    watches.delete(params.uri);
    return {};
  });

  const previous = server.server.onclose;
  server.server.onclose = () => {
    for (const watch of watches.values()) {
      watch.close();
    }
    watches.clear();
    previous?.();
  };
}
