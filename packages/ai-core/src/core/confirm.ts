/**
 * Asking a person before the agent runs a destructive tool, with a time
 * limit: no answer in time, a cancel or an abort counts as a no.
 */

export interface ConfirmTimeoutOptions {
  timeoutMs: number;
  /** Aborting answers no at once. */
  signal?: AbortSignal;
  /** Called when the time runs out (e.g. to tell the client the prompt expired). */
  onTimeout?: () => void;
}

/**
 * Wraps a confirm callback (such as `runAgent`'s `confirm`) so it answers
 * `false` when `ask` doesn't settle within `timeoutMs`, rejects, or the signal aborts.
 */
export function withConfirmTimeout<A extends unknown[]>(
  ask: (...args: A) => boolean | Promise<boolean>,
  options: ConfirmTimeoutOptions,
): (...args: A) => Promise<boolean> {
  return (...args: A) =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      function finish(allow: boolean): void {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          resolve(allow);
        }
      }
      function onAbort(): void {
        finish(false);
      }
      timer = setTimeout(() => {
        options.onTimeout?.();
        finish(false);
      }, options.timeoutMs);
      if (options.signal?.aborted) {
        finish(false);
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => ask(...args))
        .then(
          (allow) => finish(allow === true),
          () => finish(false),
        );
    });
}

export interface ConfirmationRequest {
  /** Show the prompt, e.g. emit a socket event carrying `id` and `timeoutMs`. */
  send: (id: string, timeoutMs: number) => void;
  /** Overrides the broker's timeout. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with the id when the prompt expires unanswered. */
  onTimeout?: (id: string) => void;
}

/**
 * Pending confirmations keyed by id, for prompts answered out of band (a
 * WebSocket reply): `request()` sends a prompt and waits; `answer(id, allow)`
 * settles it. Unanswered prompts resolve `false` after `timeoutMs`.
 */
export class ConfirmationBroker {
  private readonly pending = new Map<string, (allow: boolean) => void>();

  constructor(private readonly options: { timeoutMs: number; createId?: () => string }) {}

  request(req: ConfirmationRequest): Promise<boolean> {
    const id = this.options.createId?.() ?? globalThis.crypto.randomUUID();
    const timeoutMs = req.timeoutMs ?? this.options.timeoutMs;
    const ask = withConfirmTimeout(
      () =>
        new Promise<boolean>((resolve) => {
          this.pending.set(id, resolve);
          req.send(id, timeoutMs);
        }),
      { timeoutMs, signal: req.signal, onTimeout: () => req.onTimeout?.(id) },
    );
    return ask().finally(() => this.pending.delete(id));
  }

  /** Settles a pending prompt; false when the id is unknown or already settled. */
  answer(id: string, allow: boolean): boolean {
    const resolve = this.pending.get(id);
    if (!resolve) {
      return false;
    }
    this.pending.delete(id);
    resolve(allow);
    return true;
  }

  /** Answers no to every pending prompt (e.g. the client disconnected). */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) {
      this.answer(id, false);
    }
  }

  /** Prompts waiting for an answer. */
  get size(): number {
    return this.pending.size;
  }
}
