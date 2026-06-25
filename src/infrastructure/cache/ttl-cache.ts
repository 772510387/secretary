export interface TtlCacheOptions {
  /** Entries are considered fresh for this many milliseconds after being set. */
  ttlMs: number;
  /** Injectable clock (ms epoch) for testing. */
  now?: () => number;
  /** Optional cap; oldest insertions are evicted first when exceeded. */
  maxEntries?: number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * A small in-memory TTL cache with single-flight de-duplication.
 *
 * Built for the always-on daemon: when several turns (alarm nodes + chat) need
 * the same slow, slowly-changing datum (e.g. a symbol's daily technicals) within
 * a short window, this serves it once and reuses it. `getOrCompute` also collapses
 * concurrent misses for the same key into one in-flight call. Failures are never
 * cached. It is intentionally not used for sub-second data (live quotes) where the
 * caller wants freshness.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, CacheEntry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxEntries?: number;

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
    this.maxEntries = options.maxEntries;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    if (this.maxEntries !== undefined && this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  /**
   * Returns the fresh cached value, or computes it. Concurrent misses for the same
   * key share one computation. A rejected computation is propagated and not cached.
   */
  async getOrCompute(key: string, compute: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const pending = this.inflight.get(key);
    if (pending) {
      return pending;
    }

    const promise = (async () => {
      try {
        const value = await compute();
        this.set(key, value);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
