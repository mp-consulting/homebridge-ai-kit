/** A small in-memory cache whose entries expire. */

export interface TtlCacheOptions {
  /** How long an entry lives, in ms. */
  ttlMs: number;
  /** Most entries kept; the least recently used goes first. Default unbounded. */
  maxEntries?: number;
  /** Clock in ms (tests). */
  now?: () => number;
}

/**
 * Map-like cache with per-entry expiry and an optional size cap (LRU).
 * Expired entries are dropped when read and swept on every write, so it
 * never grows past the live entries.
 */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expires: number }>();
  private readonly clock: () => number;

  constructor(private readonly options: TtlCacheOptions) {
    if (!(options.ttlMs > 0)) {
      throw new Error('TtlCache needs ttlMs > 0');
    }
    if (options.maxEntries !== undefined && !(options.maxEntries >= 1)) {
      throw new Error('TtlCache maxEntries must be at least 1');
    }
    this.clock = options.now ?? Date.now;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expires <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    // Most recently used goes last.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  /** Stores `value` for `ttlMs` (default: the cache's TTL). */
  set(key: K, value: V, ttlMs: number = this.options.ttlMs): this {
    this.prune();
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.clock() + ttlMs });
    const max = this.options.maxEntries;
    while (max !== undefined && this.entries.size > max) {
      this.entries.delete(this.entries.keys().next().value as K);
    }
    return this;
  }

  /** The cached value, or the result of `load()` (cached when it resolves). */
  async getOrSet(key: K, load: () => V | Promise<V>, ttlMs?: number): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const value = await load();
    this.set(key, value, ttlMs);
    return value;
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Drops every expired entry. */
  prune(): void {
    const now = this.clock();
    for (const [key, entry] of this.entries) {
      if (entry.expires <= now) {
        this.entries.delete(key);
      }
    }
  }

  /** Live entries. */
  get size(): number {
    this.prune();
    return this.entries.size;
  }
}
