import {
  buildWatchlistSnapshot,
  classifyLimitState,
  screenCriteriaSchema,
  screenUniverse,
  type ScreenCriteria,
  type UniverseQuery,
  type UniverseStock,
  type WatchlistCategory,
  type WatchlistEntry,
  type WatchlistEntryInput,
  type WatchlistPriority,
  type WatchlistSnapshot,
} from "../domain/market/index.js";
import type { JsonValue } from "../domain/shared/index.js";

/** A read source for the market-wide universe (e.g. EastmoneyUniverseProvider). */
export interface UniverseSource {
  getUniverse(query?: UniverseQuery): Promise<UniverseStock[]>;
}

export interface WatchlistWriteSummary {
  entryCount: number;
  filePath: string;
}

/** Minimal store surface this use-case needs; WatchlistMemoryStore satisfies it. */
export interface WatchlistStore {
  importEntries(
    category: WatchlistCategory,
    entries: readonly WatchlistEntryInput[],
  ): WatchlistWriteSummary;
  writeCategory(snapshot: WatchlistSnapshot): WatchlistWriteSummary;
}

export interface BuildWatchlistFromScreenInput {
  provider: UniverseSource;
  writer: WatchlistStore;
  category?: WatchlistCategory;
  criteria?: Partial<ScreenCriteria>;
  priority?: WatchlistPriority;
  /** "replace" rebuilds the category as exactly the ranked pool; "merge" keeps existing. */
  mode?: "replace" | "merge";
  /**
   * When true, a screen that produced ZERO entries does NOT overwrite the stored pool
   * (so a transient empty/failed universe fetch never clobbers a good 100池). The caller
   * sees written:0 and can fall back to the last good pool. Default false (legacy behavior).
   */
  skipWriteWhenEmpty?: boolean;
  source?: string;
  now?: Date | string;
}

export interface BuildWatchlistFromScreenResult {
  category: WatchlistCategory;
  universeSize: number;
  screened: number;
  written: number;
  mode: "replace" | "merge";
  entries: WatchlistEntry[];
  write: WatchlistWriteSummary;
}

/**
 * Builds (or refreshes) a watchlist category from a deterministic screen of the
 * real A-share universe — the data-backed alternative to letting the model invent
 * codes. Fetch universe → filter/rank (pure `screenUniverse`) → map to entries
 * (with the ranking basis stashed in metadata) → persist. Read-only on the market
 * side; the only write is the watchlist file (audited by the store). No LLM, no broker.
 */
export async function buildWatchlistFromScreen(
  input: BuildWatchlistFromScreenInput,
): Promise<BuildWatchlistFromScreenResult> {
  const category: WatchlistCategory = input.category ?? "watchlist_today";
  const mode = input.mode ?? "replace";
  const priority: WatchlistPriority = input.priority ?? "medium";
  // Source-agnostic: the universe may come from Eastmoney or the Sina fallback.
  const source = input.source ?? "screener";
  const now = normalizeNow(input.now);
  const criteria = screenCriteriaSchema.parse(input.criteria ?? {});

  // Push the screen's sort/board/limit down so the source can fetch a few pages
  // instead of the whole market; the local screen below stays authoritative.
  const universe = await input.provider.getUniverse({
    sortBy: criteria.sortBy,
    descending: criteria.descending,
    mainBoardOnly: criteria.mainBoardOnly,
    targetCount: criteria.limit,
  });
  const screened = screenUniverse(universe, criteria);

  const entries: WatchlistEntryInput[] = screened.map((stock, index) => ({
    symbol: stock.symbol,
    market: stock.market,
    name: stock.name,
    priority,
    reason: buildReason(stock, index),
    source,
    updatedAt: now,
    metadata: screeningMetadata(stock, index, now),
  }));

  // Guard: never overwrite a good pool with an empty screen when the caller opted in.
  const skipDestructiveEmptyWrite = input.skipWriteWhenEmpty === true && entries.length === 0;

  const write = skipDestructiveEmptyWrite
    ? { entryCount: 0, filePath: "(skipped: empty screen, kept previous pool)" }
    : mode === "replace"
      ? input.writer.writeCategory(
          buildWatchlistSnapshot({
            category,
            entries,
            updatedAt: now,
            metadata: {
              source,
              screenedAt: now,
              universeSize: universe.length,
              screener: true,
              webSearchUsed: false,
              brainProviderCalled: false,
              brokerConnected: false,
              liveTrading: false,
            },
          }),
        )
      : input.writer.importEntries(category, entries);

  return {
    category,
    universeSize: universe.length,
    screened: screened.length,
    written: write.entryCount,
    mode,
    entries: buildWatchlistSnapshot({ category, entries, updatedAt: now }).entries,
    write,
  };
}

const LIMIT_STATE_LABEL: Record<string, string> = {
  limit_up: "涨停",
  limit_down: "跌停",
};

function buildReason(stock: UniverseStock, index: number): string {
  const parts = [`筛选第 ${index + 1} 名`];

  const limitLabel = LIMIT_STATE_LABEL[classifyLimitState(stock.symbol, stock.changePct)];
  if (limitLabel !== undefined) {
    parts.push(limitLabel);
  }
  if (stock.changePct !== undefined) {
    parts.push(`日涨跌 ${stock.changePct.toFixed(2)}%`);
  }
  if (stock.turnoverRate !== undefined) {
    parts.push(`换手 ${stock.turnoverRate.toFixed(2)}%`);
  }
  if (stock.amount !== undefined) {
    parts.push(`成交额 ${(stock.amount / 1e8).toFixed(1)} 亿`);
  }

  return parts.join(" · ").slice(0, 1000);
}

function screeningMetadata(
  stock: UniverseStock,
  index: number,
  now: string,
): Record<string, JsonValue> {
  return {
    rank: index + 1,
    latestPrice: stock.latestPrice ?? null,
    changePct: stock.changePct ?? null,
    turnoverRate: stock.turnoverRate ?? null,
    amount: stock.amount ?? null,
    marketCap: stock.marketCap ?? null,
    // PRE-04: deterministic 涨停/跌停 signal carried per pool entry (from changePct).
    limitState: classifyLimitState(stock.symbol, stock.changePct),
    screenedAt: now,
    screener: true,
  };
}

function normalizeNow(value: Date | string | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date().toISOString();
}
