import { describe, expect, it } from "vitest";
import {
  CachingUniverseProvider,
  cacheKey,
  type UniverseCacheEntry,
  type UniverseCacheStatus,
  type UniverseCacheStore,
} from "../../src/infrastructure/providers/index.js";
import {
  universeStockSchema,
  type UniverseQuery,
  type UniverseStock,
} from "../../src/domain/market/index.js";

const T = Date.parse("2026-06-21T02:00:00.000Z");
const query: UniverseQuery = { sortBy: "amount", descending: true, mainBoardOnly: true, targetCount: 100 };
const rows: UniverseStock[] = [universeStockSchema.parse({ symbol: "600519", market: "SSE", name: "贵州茅台", latestPrice: 1600 })];

function memStore(seed?: { ageMs: number }): UniverseCacheStore & { data: Map<string, UniverseCacheEntry> } {
  const data = new Map<string, UniverseCacheEntry>();
  if (seed) {
    data.set(cacheKey(query), { fetchedAt: new Date(T - seed.ageMs).toISOString(), rows });
  }
  return {
    data,
    read: (key) => data.get(key),
    write: (key, entry) => void data.set(key, entry),
  };
}

function fakeInner(behavior: () => Promise<UniverseStock[]>): { getUniverse: (q?: UniverseQuery) => Promise<UniverseStock[]>; calls: number } {
  const inner = {
    calls: 0,
    getUniverse: async (_q?: UniverseQuery) => {
      inner.calls += 1;
      return behavior();
    },
  };
  return inner;
}

describe("CachingUniverseProvider", () => {
  it("serves a fresh cache without calling the inner provider", async () => {
    const store = memStore({ ageMs: 60_000 }); // 1 min old, within TTL
    const inner = fakeInner(async () => []);
    const statuses: UniverseCacheStatus[] = [];
    const provider = new CachingUniverseProvider({
      inner,
      store,
      ttlMs: 10 * 60 * 1000,
      now: () => new Date(T),
      onStatus: (s) => statuses.push(s),
    });

    const out = await provider.getUniverse(query);
    expect(inner.calls).toBe(0);
    expect(out).toEqual(rows);
    expect(statuses[0]?.source).toBe("fresh-cache");
  });

  it("re-fetches when the cache is expired", async () => {
    const store = memStore({ ageMs: 20 * 60 * 1000 }); // 20 min old, stale
    const fresh = [universeStockSchema.parse({ symbol: "000001", market: "SZSE", name: "平安银行", latestPrice: 11 })];
    const inner = fakeInner(async () => fresh);
    const provider = new CachingUniverseProvider({ inner, store, ttlMs: 10 * 60 * 1000, now: () => new Date(T) });

    const out = await provider.getUniverse(query);
    expect(inner.calls).toBe(1);
    expect(out).toEqual(fresh);
    expect(store.data.get(cacheKey(query))?.rows).toEqual(fresh); // cache updated
  });

  it("falls back to a stale cache when the live fetch fails (rate-limited)", async () => {
    const store = memStore({ ageMs: 20 * 60 * 1000 });
    const inner = fakeInner(async () => {
      throw new Error("other side closed");
    });
    const statuses: UniverseCacheStatus[] = [];
    const provider = new CachingUniverseProvider({ inner, store, ttlMs: 10 * 60 * 1000, now: () => new Date(T), onStatus: (s) => statuses.push(s) });

    const out = await provider.getUniverse(query);
    expect(out).toEqual(rows); // served the stale snapshot
    expect(statuses[0]?.source).toBe("stale-cache-fallback");
  });

  it("rethrows when the fetch fails and there is no cache at all", async () => {
    const store = memStore();
    const inner = fakeInner(async () => {
      throw new Error("other side closed");
    });
    const provider = new CachingUniverseProvider({ inner, store, now: () => new Date(T) });

    await expect(provider.getUniverse(query)).rejects.toThrow(/other side closed/);
  });

  it("bypasses a fresh cache when refresh=true", async () => {
    const store = memStore({ ageMs: 60_000 });
    const inner = fakeInner(async () => rows);
    const provider = new CachingUniverseProvider({ inner, store, refresh: true, now: () => new Date(T) });

    await provider.getUniverse(query);
    expect(inner.calls).toBe(1);
  });
});
