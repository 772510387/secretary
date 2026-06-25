import {
  POOL_BUCKET_LABEL,
  buildWatchlistSnapshot,
  categorizeUniverse,
  classifyLimitState,
  renderPoolOverview,
  screenCriteriaSchema,
  screenUniverse,
  type CategorizedPoolEntry,
  type PoolBucket,
  type ScreenCriteria,
  type SealBoard,
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

/** Per-bucket priority for the categorized pool (feeds display + funnel ordering). */
const BUCKET_PRIORITY: Record<PoolBucket, WatchlistPriority> = {
  position: "high",
  limit_up: "high",
  yesterday_limit_up: "high",
  hot_sector_leader: "high",
  limit_down: "medium",
  yesterday_limit_down: "medium",
  change_top: "medium",
  amount_top: "low",
};

export interface PersistCategorizedPoolInput {
  /** A pre-fetched market universe (the caller already paid for the fetch — no network here). */
  universe: readonly UniverseStock[];
  writer: WatchlistStore;
  category?: WatchlistCategory;
  heldSymbols?: readonly string[];
  heldNames?: Readonly<Record<string, string>>;
  yesterdayLimitUpSymbols?: readonly string[];
  yesterdayLimitDownSymbols?: readonly string[];
  /** Prior cycle's changePct per symbol — enables 加速上攻 momentum priority bumps. */
  priorChangeBySymbol?: Readonly<Record<string, number>>;
  /** 封单/一字板 (level-1 盘口) per symbol, for limit-board pool stocks. */
  sealBySymbol?: ReadonlyMap<string, SealBoard>;
  minAmount?: number;
  maxTotal?: number;
  /** When true, an empty categorization does NOT overwrite the stored pool. */
  skipWriteWhenEmpty?: boolean;
  source?: string;
  now?: Date | string;
}

export interface PersistCategorizedPoolResult {
  category: WatchlistCategory;
  universeSize: number;
  written: number;
  entries: WatchlistEntry[];
  categorized: CategorizedPoolEntry[];
  /** Rendered 层级1+层级2 overview, also stashed in snapshot.metadata.poolOverview. */
  overview: string;
  counts: Partial<Record<PoolBucket, number>>;
  write: WatchlistWriteSummary;
}

/**
 * Builds and persists the CATEGORIZED 100 高关注池 from a pre-fetched universe: each
 * stock is tagged with its primary bucket (持仓/涨停/跌停/昨日涨停跌停/涨幅榜/成交额榜),
 * a 层级1+层级2 overview is rendered and stashed in snapshot metadata, and per-entry
 * metadata carries bucket + ranking basis. Pure of network/LLM — the OpenClaw-style
 * pool composition replacing the old flat 成交额 top-N. Read-only except the watchlist file.
 */
export function persistCategorizedPool(input: PersistCategorizedPoolInput): PersistCategorizedPoolResult {
  const category: WatchlistCategory = input.category ?? "watchlist_today";
  const source = input.source ?? "categorized-screener";
  const now = normalizeNow(input.now);
  const maxTotal = input.maxTotal ?? 100;

  const categorized = categorizeUniverse(input.universe, {
    heldSymbols: input.heldSymbols,
    heldNames: input.heldNames,
    yesterdayLimitUpSymbols: input.yesterdayLimitUpSymbols,
    yesterdayLimitDownSymbols: input.yesterdayLimitDownSymbols,
    minAmount: input.minAmount,
    maxTotal,
  });
  const overview = renderPoolOverview(categorized, { sealBySymbol: input.sealBySymbol });

  const counts: Partial<Record<PoolBucket, number>> = {};
  for (const entry of categorized) {
    counts[entry.bucket] = (counts[entry.bucket] ?? 0) + 1;
  }

  const entries: WatchlistEntryInput[] = categorized.map((entry, index) => {
    const adjusted = applyDynamicPriority(
      BUCKET_PRIORITY[entry.bucket],
      entry,
      input.priorChangeBySymbol?.[entry.stock.symbol],
    );
    return {
      symbol: entry.stock.symbol,
      market: entry.stock.market,
      name: entry.stock.name,
      priority: adjusted.priority,
      reason: buildCategorizedReason(entry, adjusted.notes),
      source,
      updatedAt: now,
      metadata: categorizedMetadata(entry, index, now, adjusted, input.sealBySymbol?.get(entry.stock.symbol)),
    };
  });

  const skipDestructiveEmptyWrite = input.skipWriteWhenEmpty === true && entries.length === 0;

  const write = skipDestructiveEmptyWrite
    ? { entryCount: 0, filePath: "(skipped: empty categorization, kept previous pool)" }
    : input.writer.writeCategory(
        buildWatchlistSnapshot({
          category,
          entries,
          updatedAt: now,
          metadata: {
            source,
            screenedAt: now,
            universeSize: input.universe.length,
            screener: true,
            categorized: true,
            poolOverview: overview,
            categoryCounts: counts as Record<string, JsonValue>,
            webSearchUsed: false,
            brainProviderCalled: false,
            brokerConnected: false,
            liveTrading: false,
          },
        }),
      );

  return {
    category,
    universeSize: input.universe.length,
    written: write.entryCount,
    entries: buildWatchlistSnapshot({ category, entries, updatedAt: now }).entries,
    categorized,
    overview,
    counts,
    write,
  };
}

interface DynamicPriorityResult {
  priority: WatchlistPriority;
  notes: string[];
}

const PRIORITY_LEVEL: Record<WatchlistPriority, number> = { low: 1, medium: 2, high: 3 };
const LEVEL_PRIORITY: WatchlistPriority[] = ["low", "low", "medium", "high"]; // index 1..3
/** 放量阈值 (换手%) above which a name draws attention (资金活跃). */
const HIGH_TURNOVER = 15;
/** 缩量阈值 (换手%) below which a flat/weak name loses attention. */
const LOW_TURNOVER = 1;
/** Intraday 加速 (今日较上次 changePct 提升) that earns a momentum bump. */
const MOMENTUM_DELTA = 3;
/** 主力净流入/流出额 (yuan) that moves priority — the 北向 replacement signal. */
const STRONG_INFLOW = 1e8;

/**
 * 动态优先级 (第3步): deterministic priority nudges on top of the bucket default.
 * 放量活跃 → 提优先级; 较上次加速上攻 → 提优先级; 缩量且走弱 → 降优先级. 持仓与涨停为
 * 必查/强信号，地板锁在 high，不被降级。Pure — same signals, same priority.
 */
function applyDynamicPriority(
  base: WatchlistPriority,
  entry: CategorizedPoolEntry,
  priorChangePct: number | undefined,
): DynamicPriorityResult {
  const floorHigh = entry.bucket === "position" || entry.bucket === "limit_up";
  if (floorHigh) {
    return { priority: "high", notes: [] };
  }

  let level = PRIORITY_LEVEL[base];
  const notes: string[] = [];
  const turnover = entry.stock.turnoverRate;
  const change = entry.stock.changePct;

  if (turnover !== undefined && turnover >= HIGH_TURNOVER) {
    level += 1;
    notes.push("放量提优先级");
  }
  if (
    priorChangePct !== undefined &&
    change !== undefined &&
    change - priorChangePct >= MOMENTUM_DELTA
  ) {
    level += 1;
    notes.push("较上次加速提优先级");
  }
  if (
    turnover !== undefined &&
    turnover <= LOW_TURNOVER &&
    change !== undefined &&
    change <= 0
  ) {
    level -= 1;
    notes.push("缩量走弱降优先级");
  }
  const inflow = entry.stock.mainNetInflow;
  if (inflow !== undefined && inflow >= STRONG_INFLOW) {
    level += 1;
    notes.push("主力净流入提优先级");
  } else if (inflow !== undefined && inflow <= -STRONG_INFLOW) {
    level -= 1;
    notes.push("主力净流出降优先级");
  }

  const clamped = Math.min(3, Math.max(1, level));
  return { priority: LEVEL_PRIORITY[clamped], notes };
}

function buildCategorizedReason(entry: CategorizedPoolEntry, dynamicNotes: readonly string[] = []): string {
  const stock = entry.stock;
  const parts = [`${POOL_BUCKET_LABEL[entry.bucket]} · 类内第 ${entry.rankInBucket} 名`];
  if (stock.changePct !== undefined) {
    parts.push(`日涨跌 ${stock.changePct.toFixed(2)}%`);
  }
  if (stock.turnoverRate !== undefined) {
    parts.push(`换手 ${stock.turnoverRate.toFixed(2)}%`);
  }
  if (stock.amount !== undefined) {
    parts.push(`成交额 ${(stock.amount / 1e8).toFixed(1)} 亿`);
  }
  if (stock.mainNetInflow !== undefined) {
    parts.push(`主力净流入 ${(stock.mainNetInflow / 1e8).toFixed(2)} 亿`);
  }
  parts.push(...dynamicNotes);
  return parts.join(" · ").slice(0, 1000);
}

function categorizedMetadata(
  entry: CategorizedPoolEntry,
  index: number,
  now: string,
  dynamic: DynamicPriorityResult,
  seal: SealBoard | undefined,
): Record<string, JsonValue> {
  const stock = entry.stock;
  return {
    rank: index + 1,
    bucket: entry.bucket,
    bucketLabel: POOL_BUCKET_LABEL[entry.bucket],
    rankInBucket: entry.rankInBucket,
    priority: dynamic.priority,
    priorityNotes: dynamic.notes,
    sector: stock.sector ?? null,
    latestPrice: stock.latestPrice ?? null,
    changePct: stock.changePct ?? null,
    turnoverRate: stock.turnoverRate ?? null,
    amount: stock.amount ?? null,
    marketCap: stock.marketCap ?? null,
    mainNetInflow: stock.mainNetInflow ?? null,
    mainNetInflowRatio: stock.mainNetInflowRatio ?? null,
    sealAmount: seal ? seal.sealAmount : null,
    sealVolumeLots: seal ? seal.sealVolumeLots : null,
    isOneWordBoard: seal ? seal.isOneWord : null,
    limitState: classifyLimitState(stock.symbol, stock.changePct),
    screenedAt: now,
    screener: true,
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
