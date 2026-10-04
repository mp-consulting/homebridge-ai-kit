/**
 * Change notifications for the MCP resources. Listens on the Homebridge UI's
 * socket.io namespaces (`/accessories`, `/log`, `/status`); when the socket
 * cannot connect (e.g. the UI does not accept the token on sockets) it falls
 * back to polling the REST API and comparing snapshots.
 */

import { io } from 'socket.io-client';
import type { HomebridgeClient } from './homebridge-client.js';

export type LiveTopic = 'accessories' | 'log' | 'status';

export interface LiveWatch {
  close(): void;
}

/** Starts watching `topic`, calling `onChange` (throttled) whenever it changes. */
export type LiveSource = (topic: LiveTopic, onChange: () => void) => LiveWatch;

/** The subset of a socket.io client socket this module uses. */
export interface LiveSocket {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  close(): unknown;
}

export type SocketConnect = (url: string, options: { auth: { token: string }; transports: string[]; reconnectionDelayMax: number }) => LiveSocket;

interface TopicSpec {
  /** Message that asks the namespace to start streaming. */
  start: [string, ...unknown[]];
  /** Event that carries updates. */
  event: string;
  pollMs: number;
}

/** Event names from the Glass UI (and homebridge-config-ui-x) gateways. */
export const LIVE_TOPICS: Record<LiveTopic, TopicSpec> = {
  accessories: { start: ['get-accessories'], event: 'accessories-data', pollMs: 10_000 },
  log: { start: ['tail-log', { cols: 200, rows: 50 }], event: 'stdout', pollMs: 5_000 },
  status: { start: ['monitor-server-status'], event: 'homebridge-status', pollMs: 15_000 },
};

export interface LiveOptions {
  /** socket.io client factory (tests inject a fake). */
  connect?: SocketConnect;
  /** Minimum time between two notifications for one topic. */
  throttleMs?: number;
  /** Override the polling interval of every topic. */
  pollMs?: number;
}

/** A snapshot of a topic used to detect changes while polling. */
async function fingerprint(client: HomebridgeClient, topic: LiveTopic): Promise<string> {
  switch (topic) {
    case 'accessories':
      return JSON.stringify((await client.getAccessories()).map((a) => [a.uniqueId, a.values]));
    case 'log':
      return (await client.getLogTail(8192)).text;
    case 'status':
      return JSON.stringify(await client.getHomebridgeStatus());
  }
}

export function createLiveSource(client: HomebridgeClient, options: LiveOptions = {}): LiveSource {
  const connect = options.connect ?? (io as unknown as SocketConnect);
  const throttleMs = options.throttleMs ?? 1000;

  return (topic, onChange) => {
    const spec = LIVE_TOPICS[topic];
    let closed = false;
    let socket: LiveSocket | undefined;
    let poller: ReturnType<typeof setInterval> | undefined;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let lastNotified = 0;

    const notify = () => {
      if (closed || pending) {
        return;
      }
      const wait = lastNotified + throttleMs - Date.now();
      const fire = () => {
        pending = undefined;
        lastNotified = Date.now();
        if (!closed) {
          onChange();
        }
      };
      if (wait <= 0) {
        fire();
      } else {
        pending = setTimeout(fire, wait);
      }
    };

    const startPolling = async () => {
      if (closed || poller) {
        return;
      }
      let previous = await fingerprint(client, topic).catch(() => undefined);
      if (closed) {
        return;
      }
      poller = setInterval(async () => {
        const current = await fingerprint(client, topic).catch(() => undefined);
        if (current !== undefined && previous !== undefined && current !== previous) {
          notify();
        }
        previous = current ?? previous;
      }, options.pollMs ?? spec.pollMs);
    };

    void (async () => {
      let connected = false;
      try {
        const token = await client.accessToken();
        if (closed) {
          return;
        }
        socket = connect(`${client.url}/${topic}`, { auth: { token }, transports: ['websocket'], reconnectionDelayMax: 30_000 });
        socket.on('connect', () => {
          connected = true;
          socket!.emit(...spec.start);
        });
        socket.on(spec.event, notify);
        socket.on('connect_error', () => {
          if (!connected) {
            socket?.close();
            socket = undefined;
            void startPolling();
          }
        });
      } catch {
        void startPolling();
      }
    })();

    return {
      close() {
        closed = true;
        socket?.close();
        clearInterval(poller);
        clearTimeout(pending);
      },
    };
  };
}

/**
 * Wraps a source so every topic has at most one underlying watch (one socket
 * or poller), however many MCP sessions subscribe. The watch opens with the
 * first subscriber and closes with the last.
 */
export function shareLiveSource(source: LiveSource): LiveSource {
  const topics = new Map<LiveTopic, { watch: LiveWatch; listeners: Set<() => void> }>();
  return (topic, onChange) => {
    let entry = topics.get(topic);
    if (!entry) {
      const listeners = new Set<() => void>();
      const watch = source(topic, () => {
        for (const listener of [...listeners]) {
          listener();
        }
      });
      entry = { watch, listeners };
      topics.set(topic, entry);
    }
    const listener = () => onChange();
    entry.listeners.add(listener);
    const shared = entry;
    return {
      close() {
        if (!shared.listeners.delete(listener) || shared.listeners.size > 0) {
          return;
        }
        shared.watch.close();
        if (topics.get(topic) === shared) {
          topics.delete(topic);
        }
      },
    };
  };
}
