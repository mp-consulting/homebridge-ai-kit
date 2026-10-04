/** Per-key sliding-window rate limiting, e.g. Assistant requests per user. */

export interface RateLimiterOptions {
  /** Requests allowed per key within `windowMs`. */
  limit: number;
  windowMs: number;
  /** Clock in ms (tests). */
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window after this one. */
  remaining: number;
  /** When refused: ms until the oldest request leaves the window. 0 when allowed. */
  retryAfterMs: number;
}

/**
 * Allows `limit` requests per key in any `windowMs` window. Keys with no
 * request in the last window are evicted (at most once per window, during
 * calls), so memory stays bounded by the keys active recently.
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly clock: () => number;
  private lastPrune: number;

  constructor(private readonly options: RateLimiterOptions) {
    if (!(options.limit >= 1) || !(options.windowMs > 0)) {
      throw new Error('SlidingWindowRateLimiter needs limit >= 1 and windowMs > 0');
    }
    this.clock = options.now ?? Date.now;
    this.lastPrune = this.clock();
  }

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((at) => now - at < this.options.windowMs);
    if (list.length > 0) {
      this.hits.set(key, list);
    } else {
      this.hits.delete(key);
    }
    return list;
  }

  private maybePrune(now: number): void {
    if (now - this.lastPrune >= this.options.windowMs) {
      this.prune();
    }
  }

  /** Counts a request for `key` when there is room; never counts a refused one. */
  consume(key: string): RateLimitResult {
    const now = this.clock();
    this.maybePrune(now);
    const list = this.recent(key, now);
    if (list.length >= this.options.limit) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, list[0]! + this.options.windowMs - now) };
    }
    list.push(now);
    this.hits.set(key, list);
    return { allowed: true, remaining: this.options.limit - list.length, retryAfterMs: 0 };
  }

  /** What `consume` would answer, without counting anything. */
  peek(key: string): RateLimitResult {
    const now = this.clock();
    const list = this.recent(key, now);
    if (list.length >= this.options.limit) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, list[0]! + this.options.windowMs - now) };
    }
    return { allowed: true, remaining: this.options.limit - list.length, retryAfterMs: 0 };
  }

  /** Forgets one key, or every key. */
  reset(key?: string): void {
    if (key === undefined) {
      this.hits.clear();
    } else {
      this.hits.delete(key);
    }
  }

  /** Evicts every key without a request in the current window. */
  prune(): void {
    const now = this.clock();
    this.lastPrune = now;
    for (const key of [...this.hits.keys()]) {
      this.recent(key, now);
    }
  }

  /** Keys currently tracked. */
  get size(): number {
    return this.hits.size;
  }
}
