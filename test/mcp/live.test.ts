import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIVE_TOPICS, createLiveSource, shareLiveSource } from '../../src/mcp/live.js';
import type { LiveSocket, LiveSource } from '../../src/mcp/live.js';
import { mockClient } from './helpers.js';

/** A socket whose emit() records outgoing messages; `fire` simulates incoming events. */
class FakeSocket implements LiveSocket {
  readonly incoming = new EventEmitter();
  readonly sent: unknown[][] = [];
  closed = false;
  on(event: string, listener: (...args: unknown[]) => void) {
    this.incoming.on(event, listener);
    return this;
  }
  emit(...args: unknown[]) {
    this.sent.push(args);
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    this.incoming.emit(event, ...args);
  }
  close() {
    this.closed = true;
    return this;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createLiveSource', () => {
  it('connects to the namespace with the token and notifies (throttled) on updates', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const connect = vi.fn(() => socket);
    const client = mockClient({ accessToken: vi.fn().mockResolvedValue('jwt') });
    const onChange = vi.fn();
    const watch = createLiveSource(client, { connect, throttleMs: 1000 })('accessories', onChange);
    await vi.advanceTimersByTimeAsync(0);

    expect(connect).toHaveBeenCalledWith('http://hb.local:8581/accessories', expect.objectContaining({ auth: { token: 'jwt' } }));
    socket.fire('connect');
    expect(socket.sent).toEqual([LIVE_TOPICS.accessories.start]);

    socket.fire('accessories-data', []);
    expect(onChange).toHaveBeenCalledTimes(1);
    socket.fire('accessories-data', []);
    socket.fire('accessories-data', []);
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(2);

    socket.fire('accessories-data', []);
    watch.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(socket.closed).toBe(true);
  });

  it('keeps the socket after a later connect_error (reconnecting)', async () => {
    const socket = new FakeSocket();
    const client = mockClient({ accessToken: vi.fn().mockResolvedValue('jwt'), getLogTail: vi.fn() });
    const watch = createLiveSource(client, { connect: () => socket })('log', vi.fn());
    await new Promise((r) => setImmediate(r));
    socket.fire('connect');
    socket.fire('connect_error', new Error('down'));
    expect(socket.closed).toBe(false);
    expect(client.getLogTail).not.toHaveBeenCalled();
    watch.close();
  });

  it('falls back to polling when the socket is refused', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const getHomebridgeStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: 'up' })
      .mockResolvedValueOnce({ status: 'up' })
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce({ status: 'down' });
    const client = mockClient({ accessToken: vi.fn().mockResolvedValue('hbg_x'), getHomebridgeStatus });
    const onChange = vi.fn();
    const watch = createLiveSource(client, { connect: () => socket, pollMs: 100, throttleMs: 0 })('status', onChange);
    await vi.advanceTimersByTimeAsync(0);
    socket.fire('connect_error', new Error('unauthorized'));
    expect(socket.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100); // same
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100); // error, ignored
    await vi.advanceTimersByTimeAsync(100); // changed
    expect(onChange).toHaveBeenCalledTimes(1);
    watch.close();
  });

  it('polls when no token can be had, for every topic', async () => {
    vi.useFakeTimers();
    let n = 0;
    const client = mockClient({
      accessToken: vi.fn().mockRejectedValue(new Error('no login')),
      getAccessories: vi.fn(async () => [{ uniqueId: 'a', values: { On: n++ } }]),
      getLogTail: vi.fn(async () => ({ text: `line ${n++}`, truncated: false })),
    });
    const onChange = vi.fn();
    const source = createLiveSource(client, { pollMs: 50, throttleMs: 0 });
    const a = source('accessories', onChange);
    const l = source('log', onChange);
    await vi.advanceTimersByTimeAsync(60);
    expect(onChange).toHaveBeenCalledTimes(2);
    a.close();
    l.close();
  });

  it('does nothing if closed before the token arrives', async () => {
    let resolve!: (t: string) => void;
    const connect = vi.fn();
    const client = mockClient({ accessToken: vi.fn(() => new Promise<string>((r) => (resolve = r))) });
    const watch = createLiveSource(client, { connect })('status', vi.fn());
    watch.close();
    resolve('t');
    await new Promise((r) => setImmediate(r));
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not start polling if closed during the first snapshot', async () => {
    let resolve!: (v: unknown) => void;
    const client = mockClient({
      accessToken: vi.fn().mockRejectedValue(new Error('x')),
      getHomebridgeStatus: vi.fn(() => new Promise((r) => (resolve = r))),
    });
    const watch = createLiveSource(client, { pollMs: 10 })('status', vi.fn());
    await new Promise((r) => setImmediate(r));
    watch.close();
    resolve({});
    await new Promise((r) => setTimeout(r, 30));
    expect(client.getHomebridgeStatus).toHaveBeenCalledTimes(1);
  });
});

describe('shareLiveSource', () => {
  it('opens one watch per topic and closes it with the last subscriber', () => {
    const fire: Record<string, () => void> = {};
    const close = vi.fn();
    const source = vi.fn<LiveSource>((topic, onChange) => {
      fire[topic] = onChange;
      return { close };
    });
    const shared = shareLiveSource(source);
    const a = vi.fn();
    const b = vi.fn();
    const wa = shared('log', a);
    const wb = shared('log', b);
    const ws = shared('status', vi.fn());
    expect(source).toHaveBeenCalledTimes(2);
    fire.log();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    wa.close();
    wa.close();
    expect(close).not.toHaveBeenCalled();
    fire.log();
    expect(a).toHaveBeenCalledTimes(1);
    wb.close();
    ws.close();
    expect(close).toHaveBeenCalledTimes(2);
    shared('log', vi.fn());
    expect(source).toHaveBeenCalledTimes(3);
  });
});
