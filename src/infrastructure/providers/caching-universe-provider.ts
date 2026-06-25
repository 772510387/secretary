import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  universeStockSchema,
  type UniverseQuery,
  type UniverseStock,
} from "../../domain/market/index.js";
import type { UniverseProvider } from "./eastmoney-universe-provider.js";

export interface UniverseCacheEntry {
  fetchedAt: string;
  rows: UniverseStock[];
}

export interface UniverseCacheStore {
  read(key: string): UniverseCacheEntry | undefined;
  write(key: string, entry: UniverseCacheEntry): void;
}

const cacheEntrySchema = z
  .object({
    fetchedAt: z.string(),
    rows: z.array(universeStockSchema),
  })
  .strict();

/** File-backed cache so a `--dry-run` and the real build (separate processes) reuse one fetch. */
export class FileUniverseCacheStore implements UniverseCacheStore {
  constructor(private readonly cacheDir: string) {}

  read(key: string): UniverseCacheEntry | undefined {
    const file = this.fileFor(key);

    if (!existsSync(file)) {
      return undefined;
    }

    try {
      return cacheEntrySchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return undefined; // a corrupt cache is simply a miss
    }
  }

  write(key: string, entry: UniverseCacheEntry): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(this.fileFor(key), JSON.stringify(entry), "utf8");
    } catch {
      // Best-effort cache; a write failure must never break the build.
    }
  }

  private fileFor(key: string): string {
    return path.join(this.cacheDir, `universe-${safeKey(key)}.json`);
  }
}

export type UniverseCacheSource = "fresh-cache" | "fetched" | "stale-cache-fallback";

export interface UniverseCacheStatus {
  source: UniverseCacheSource;
  ageMs?: number;
}

export interface CachingUniverseProviderOptions {
  inner: UniverseProvider;
  store: UniverseCacheStore;
  /** Cache freshness window; default 10 min. */
  ttlMs?: number;
  /** Force a re-fetch (and overwrite the cache). */
  refresh?: boolean;
  now?: () => Date;
  onStatus?: (status: UniverseCacheStatus) => void;
}

/**
 * Wraps a universe provider with a short-lived cache + rate-limit degradation:
 *
 * - Within the TTL window, repeated screens reuse one fetch (kills the "ran it
 *   300 times while testing" amplification).
 * - If the live fetch fails (e.g. Eastmoney rate-limited the IP) but ANY cached
 *   snapshot exists, it serves the stale snapshot with a warning instead of
 *   erroring out — the build still produces a result.
 */
export class CachingUniverseProvider implements UniverseProvider {
  private readonly inner: UniverseProvider;
  private readonly store: UniverseCacheStore;
  private readonly ttlMs: number;
  private readonly refresh: boolean;
  private readonly now: () => Date;
  private readonly onStatus?: (status: UniverseCacheStatus) => void;

  constructor(options: CachingUniverseProviderOptions) {
    this.inner = options.inner;
    this.store = options.store;
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.refresh = options.refresh ?? false;
    this.now = options.now ?? (() => new Date());
    this.onStatus = options.onStatus;
  }

  async getUniverse(query: UniverseQuery = {}): Promise<UniverseStock[]> {
    const key = cacheKey(query);
    const cached = this.store.read(key);
    const nowMs = this.now().getTime();

    if (!this.refresh && cached) {
      const ageMs = nowMs - Date.parse(cached.fetchedAt);

      if (ageMs >= 0 && ageMs < this.ttlMs) {
        this.onStatus?.({ source: "fresh-cache", ageMs });
        return cached.rows;
      }
    }

    try {
      const rows = await this.inner.getUniverse(query);
      this.store.write(key, { fetchedAt: new Date(nowMs).toISOString(), rows });
      this.onStatus?.({ source: "fetched" });
      return rows;
    } catch (error) {
      if (cached) {
        this.onStatus?.({ source: "stale-cache-fallback", ageMs: nowMs - Date.parse(cached.fetchedAt) });
        return cached.rows;
      }

      throw error;
    }
  }
}

export function cacheKey(query: UniverseQuery): string {
  return [
    query.sortBy ?? "amount",
    query.descending === false ? "asc" : "desc",
    query.mainBoardOnly === true ? "main" : "all",
    query.targetCount ?? "all",
  ].join("-");
}

function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80) || "default";
}
