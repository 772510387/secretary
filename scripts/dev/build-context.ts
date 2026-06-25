import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "../../src/config/schema.js";
import {
  AsOfMarketReader,
  DEFAULT_ASOF_INDEX_DEFINITIONS,
  KlineAsOfIndexSource,
  buildPaperAgentToolDeps,
  buildPaperAgentTools,
  buildWatchlistFromScreen,
  inferMarket,
  type AsOfIndexSource,
  type AskIndex,
  type AskTechnical,
  type AskWebSearchContext,
  type MarketDataHealth,
  type PaperAgentTools,
  type PaperOpsToolCommand,
  type PaperPortfolioView,
  type PaperQuoteView,
  type PaperTechnicalView,
  type WeChatBridgeContext,
} from "../../src/app/index.js";
import {
  accountSchema,
  calculatePortfolioValuation,
  positionSchema,
  type Account,
  type Position,
} from "../../src/domain/portfolio/index.js";
import {
  buildWatchlistSnapshot,
  computeThemeHeat,
  type KlineBar,
  type StockSymbolInfo,
  type ThemeHeatSummary,
} from "../../src/domain/market/index.js";
import { buildNodeSearchQuery, type CerebellumAlarmType } from "../../src/domain/cerebellum/index.js";
import {
  snapshotWatchlist,
  type PlanShortlistEntry,
  type PlanWatchlistEntry,
} from "../../src/domain/plan/index.js";
import { WatchlistMemoryStore } from "../../src/infrastructure/storage/index.js";
import {
  CachingUniverseProvider,
  EastmoneyUniverseProvider,
  FallbackUniverseProvider,
  FileUniverseCacheStore,
  FixtureHistoryProvider,
  SinaUniverseProvider,
  TavilySearchProvider,
  TencentHistoryProvider,
  TencentIndexProvider,
  TencentQuoteProvider,
  type HistoryProvider,
} from "../../src/infrastructure/providers/index.js";
import { createPortfolioMemoryPaths } from "../../src/infrastructure/storage/index.js";
import { TtlCache } from "../../src/infrastructure/cache/index.js";

const positionsSchema = z.array(positionSchema);

// Daily technicals (MA/trend/60-day range) only change at end of day, so a short
// process-wide cache lets the many turns of a resident daemon (alarm nodes + chat)
// reuse one fetch instead of re-pulling history per symbol every time. Live quotes
// and indices stay uncached on purpose — those callers want freshness.
const TECHNICALS_CACHE_TTL_MS = 3 * 60_000;
const technicalsCache = new TtlCache<AskTechnical>({
  ttlMs: TECHNICALS_CACHE_TTL_MS,
  maxEntries: 512,
});

// Questions that benefit from live news / policy (trigger an auto web search).
const MARKET_QUERY_RE =
  /行情|大盘|股市|新闻|政策|消息|趋势|走势|分析|研判|下周|本周|后市|题材|板块|怎么操作|要不要|能不能买|该买|该卖|加仓|减仓|止盈|止损/;

/**
 * Assembles the rich market context the model needs to actually analyze: the
 * paper account, live prices, daily technicals (MA/trend/60-day range) for held
 * symbols, market indices, and (for analysis-type questions) a Tavily news search.
 * Every fetch is best-effort — a failure degrades the context, it never throws.
 */
export async function buildBridgeContext(input: {
  config: AppConfig;
  memoryDir: string;
  question: string;
  /** When set, this is an alarm node: use the node-specific search query + read the 100池. */
  alarmType?: CerebellumAlarmType;
  forceWebSearch?: boolean;
  /** Read the maintained 100 高关注池 and price pool∪positions (alarm nodes; default off for chat). */
  includeWatchlist?: boolean;
}): Promise<WeChatBridgeContext> {
  const asOf = new Date().toISOString();
  const paths = createPortfolioMemoryPaths(input.memoryDir);
  const account = readAccount(paths.accountPath);
  const positions = readPositions(paths.positionsPath);

  // The 100池: read only for alarm nodes (chat doesn't need to price 100 symbols).
  const watchlist = input.includeWatchlist ? readWatchlist100(input.memoryDir) : undefined;

  // Price the union of held + pool symbols so an EMPTY account still has real data
  // (this morning's "pricesAvailable:false" came from pricing positions only → []).
  const priceSymbols = unionSymbols(positions, watchlist);
  // Technicals stay bounded to held symbols (60-day history per symbol is expensive).
  const technicalSymbols: StockSymbolInfo[] = positions.map(toSymbolInfo);

  // Alarm nodes get a real, node-specific Chinese query; chat keeps the user's question.
  const searchQuery =
    input.alarmType !== undefined ? buildNodeSearchQuery(input.alarmType, asOf) : input.question;

  const [prices, technicals, indices, webSearch] = await Promise.all([
    fetchPrices(priceSymbols, input.config),
    fetchTechnicals(technicalSymbols, input.config),
    fetchIndices(input.config),
    maybeWebSearch(input.config, searchQuery, input.forceWebSearch),
  ]);

  const dataHealth = buildDataHealth({
    asOf,
    prices,
    priceSymbolCount: priceSymbols.length,
    indices,
    watchlist,
    includeWatchlist: input.includeWatchlist ?? false,
  });

  return { account, positions, prices, technicals, indices, watchlist, dataHealth, webSearch };
}

function toSymbolInfo(position: Position): StockSymbolInfo {
  return { symbol: position.symbol, market: position.market, name: position.name };
}

/** Held ∪ pool symbols, deduped — what the eye prices for an alarm node. */
function unionSymbols(
  positions: Position[],
  watchlist: PlanWatchlistEntry[] | undefined,
): StockSymbolInfo[] {
  const seen = new Set<string>();
  const out: StockSymbolInfo[] = [];
  for (const position of positions) {
    if (!seen.has(position.symbol)) {
      seen.add(position.symbol);
      out.push(toSymbolInfo(position));
    }
  }
  for (const entry of watchlist ?? []) {
    if (!seen.has(entry.symbol)) {
      seen.add(entry.symbol);
      out.push({ symbol: entry.symbol, market: entry.market, name: entry.name });
    }
  }
  return out;
}

/** Reads the maintained 100 高关注池 from memory (lean PlanWatchlistEntry shape). */
export function readWatchlist100(memoryDir: string): PlanWatchlistEntry[] {
  try {
    const snapshot = new WatchlistMemoryStore({ memoryDir }).readCategory("watchlist_today");
    return snapshotWatchlist(snapshot.entries);
  } catch {
    return [];
  }
}

/**
 * PRE-05: mirror the funnel's 10 潜力股 (shortlist) to `potential_stocks.json` so the
 * spec's standalone artifact actually exists (previously the shortlist only lived inside
 * the DailyTradingPlan). Never clobbers with an empty list. No model, no network.
 */
export function writePotentialStocksPool(input: {
  memoryDir: string;
  shortlist: readonly PlanShortlistEntry[];
  now: string;
}): number {
  if (input.shortlist.length === 0) {
    return 0;
  }
  const entries = input.shortlist.slice(0, 10).map((entry, index) => ({
    symbol: entry.symbol,
    market: entry.market,
    name: entry.name,
    priority: "high" as const,
    reason: entry.rationale.slice(0, 1000),
    source: "funnel-shortlist",
    updatedAt: input.now,
    metadata: { rank: entry.rank ?? index + 1, fromFunnel: true },
  }));
  const result = new WatchlistMemoryStore({ memoryDir: input.memoryDir }).writeCategory(
    buildWatchlistSnapshot({
      category: "potential_stocks",
      entries,
      updatedAt: input.now,
      metadata: {
        source: "funnel-shortlist",
        screener: false,
        fromFunnel: true,
        brainProviderCalled: false,
        brokerConnected: false,
        liveTrading: false,
      },
    }),
  );
  return result.entryCount;
}

export interface RefreshWatchlistResult {
  watchlist100: PlanWatchlistEntry[];
  universeSize: number;
  screened: number;
  /** true when the live screen failed/empty and we fell back to the last stored pool. */
  degraded: boolean;
  /** 新题材热度 — deterministic market-wide heat (涨停家数/涨跌分布/热度评分) for the brain. */
  themeHeat?: ThemeHeatSummary;
}

/**
 * 换血 (eye): deterministically rebuild the 100 高关注池 from the real A-share universe
 * (成交额 top, MAIN-BOARD ONLY per the 禁科创/创业板 constitution), persist it to
 * `watchlist_today.json`, and return it for the funnel. No model, no hallucination.
 * On a total fetch failure it degrades to the last stored pool (and says so) rather
 * than inventing codes.
 */
export async function refreshWatchlist100(input: {
  config: AppConfig;
  memoryDir: string;
  limit?: number;
  minAmount?: number;
  now?: Date | string;
}): Promise<RefreshWatchlistResult> {
  const provider = new CachingUniverseProvider({
    inner: new FallbackUniverseProvider([
      new EastmoneyUniverseProvider(),
      new SinaUniverseProvider(),
    ]),
    store: new FileUniverseCacheStore(path.join(input.memoryDir, "market", "cache")),
  });

  // 新题材热度 (眼): deterministic market-wide heat from the broad universe (no model).
  // Cheap (the CachingUniverseProvider serves the screen below from the same fetch path).
  let themeHeat: ThemeHeatSummary | undefined;
  try {
    const broad = await provider.getUniverse({ targetCount: 500 });
    themeHeat = computeThemeHeat(broad);
  } catch {
    themeHeat = undefined; // degrade silently; the screen below still runs
  }

  const runScreen = async (minAmount: number) => {
    const screen = await buildWatchlistFromScreen({
      provider,
      writer: new WatchlistMemoryStore({ memoryDir: input.memoryDir }),
      category: "watchlist_today",
      criteria: {
        limit: input.limit ?? 100,
        sortBy: "amount",
        minAmount,
        mainBoardOnly: true, // 禁科创(688)/创业板(300) — only tradable main-board names enter the pool
      },
      // INFRA-02: never overwrite a good pool with an empty/failed screen.
      skipWriteWhenEmpty: true,
      now: input.now,
    });
    return {
      watchlist100: snapshotWatchlist(screen.entries),
      universeSize: screen.universeSize,
      screened: screen.screened,
    };
  };

  try {
    const primary = await runScreen(input.minAmount ?? 1e8);
    if (primary.watchlist100.length > 0) {
      return { ...primary, degraded: false, themeHeat };
    }
    // 盘前/低量兜底：开盘前今日成交额≈0，成交额阈值会把整个 universe 滤空。只要 universe 非空，
    // 就放宽阈值再筛一次（仍仅主板），保证“没有就去查”能真的建出一个池，而不是空手而归。
    if (primary.universeSize > 0) {
      const relaxed = await runScreen(0);
      if (relaxed.watchlist100.length > 0) {
        console.error(
          `(100池换血：成交额阈值过滤后为空，已放宽阈值重筛 ${relaxed.watchlist100.length} 支（盘前/低量时段）)`,
        );
        return { ...relaxed, degraded: false, themeHeat };
      }
    }
  } catch (error) {
    console.error(
      `(100池换血失败，降级使用上次的池：${error instanceof Error ? error.message : String(error)})`,
    );
  }

  // Degrade: reuse the last stored pool rather than fabricate one.
  const fallback = readWatchlist100(input.memoryDir);
  return { watchlist100: fallback, universeSize: 0, screened: fallback.length, degraded: true, themeHeat };
}

/** Builds the explicit eye-health signal: which fetches that SHOULD have data came back empty. */
function buildDataHealth(input: {
  asOf: string;
  prices: Record<string, number>;
  priceSymbolCount: number;
  indices: AskIndex[];
  watchlist: PlanWatchlistEntry[] | undefined;
  includeWatchlist: boolean;
}): MarketDataHealth {
  const pricedSymbols = Object.keys(input.prices).length;
  const watchlistCount = input.watchlist?.length ?? 0;
  const notes: string[] = [];

  if (input.priceSymbolCount > 0 && pricedSymbols === 0) {
    notes.push("行情报价拉取失败或为空，已降级");
  }
  if (input.indices.length === 0) {
    notes.push("大盘指数不可用，已降级");
  }
  if (input.includeWatchlist && watchlistCount === 0) {
    notes.push("100支高关注池为空（尚未刷新或筛选失败）");
  }

  return {
    asOf: input.asOf,
    pricedSymbols,
    indicesCount: input.indices.length,
    watchlistCount,
    degraded: notes.length > 0,
    notes,
  };
}

async function fetchPrices(
  symbols: StockSymbolInfo[],
  config: AppConfig,
): Promise<Record<string, number>> {
  if (symbols.length === 0) {
    return {};
  }

  try {
    const provider = new TencentQuoteProvider({ timeoutMs: config.market.quoteTimeoutMs });
    const quotes = await provider.getQuotes(symbols);
    return Object.fromEntries(quotes.map((quote) => [quote.symbol, quote.latestPrice]));
  } catch {
    return {};
  }
}

async function fetchTechnicals(
  symbols: StockSymbolInfo[],
  config: AppConfig,
): Promise<AskTechnical[]> {
  if (symbols.length === 0) {
    return [];
  }

  const provider = new TencentHistoryProvider({ timeoutMs: config.market.quoteTimeoutMs });

  // Fetch every symbol's technicals concurrently (cache-served when fresh); a
  // failure skips just that symbol. Concurrent misses for the same symbol collapse
  // into one upstream call via the cache's single-flight de-dup.
  const settled = await Promise.all(
    symbols.map(async (symbol): Promise<AskTechnical | undefined> => {
      const key = `${symbol.market}:${symbol.symbol}`;
      try {
        return await technicalsCache.getOrCompute(key, async () => {
          const indicators = await provider.getDailyTechnicalIndicators(symbol, { count: 60 });
          return {
            symbol: indicators.symbol,
            market: indicators.market,
            name: symbol.name,
            asOfDate: indicators.asOfDate,
            trend: indicators.trend,
            ma5: indicators.ma5,
            ma10: indicators.ma10,
            ma20: indicators.ma20,
            high60: indicators.high60,
            low60: indicators.low60,
            rangePosition60: indicators.rangePosition60,
          };
        });
      } catch {
        return undefined; // skip this symbol's technicals on failure
      }
    }),
  );

  return settled.filter((technical): technical is AskTechnical => technical !== undefined);
}

async function fetchIndices(config: AppConfig): Promise<AskIndex[]> {
  try {
    const provider = new TencentIndexProvider({ timeoutMs: config.market.quoteTimeoutMs });
    const snapshots = await provider.getIndexes();
    return snapshots.map((snapshot) => ({
      indexId: snapshot.indexId,
      name: snapshot.name,
      latestPrice: snapshot.latestPrice,
      changePct: snapshot.changePct,
      asOfDate: (snapshot.providerTime ?? snapshot.receivedAt).slice(0, 10),
    }));
  } catch {
    return [];
  }
}

async function maybeWebSearch(
  config: AppConfig,
  question: string,
  force?: boolean,
): Promise<AskWebSearchContext | undefined> {
  if (config.search.provider !== "tavily" || !config.search.tavilyApiKey) {
    return undefined;
  }

  if (!force && !MARKET_QUERY_RE.test(question)) {
    return undefined;
  }

  try {
    const provider = new TavilySearchProvider({ apiKey: config.search.tavilyApiKey });
    const result = await provider.search(question, { maxResults: config.search.maxResults });
    return {
      query: result.query,
      answer: result.answer,
      results: result.results.map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
      })),
    };
  } catch {
    return undefined;
  }
}

/**
 * As-of (no-look-ahead) context for FAITHFUL replay. Same shape as buildBridgeContext,
 * but prices/technicals come from {@link AsOfMarketReader} bounded to `asOfDate` (pre-
 * close nodes value at the prior trading day). Account/positions are the CURRENT stored
 * state (no historical snapshot). Indices and web search are omitted — there is no as-of
 * source for them, so including live ones would be look-ahead. Daily-bar granularity:
 * intraday nodes within a day all see "through the prior close" until post-close.
 */
export async function buildAsOfBridgeContext(input: {
  account?: Account;
  positions: Position[];
  /** Optional replay pool. Used when the account is empty so replay still has market targets. */
  watchlist?: PlanWatchlistEntry[];
  /** Bound replay fetch fan-out; positions are always included, then ranked pool names up to this cap. */
  maxWatchlistSymbols?: number;
  asOfDate: string;
  /** true = same trading day's bar is settled (post-close nodes, >= 15:30). */
  sameDayBarIncluded: boolean;
  historyProvider: HistoryProvider;
  /** Optional no-look-ahead index source for faithful replay. */
  indexSource?: AsOfIndexSource;
  historyCount?: number;
}): Promise<WeChatBridgeContext> {
  const rankedWatchlist = [...(input.watchlist ?? [])]
    .sort((left, right) => (left.rank ?? Number.POSITIVE_INFINITY) - (right.rank ?? Number.POSITIVE_INFINITY))
    .slice(0, input.maxWatchlistSymbols ?? 20);
  const symbols = unionSymbols(input.positions, rankedWatchlist);
  const reader = new AsOfMarketReader({
    historyProvider: input.historyProvider,
    indexSource: input.indexSource,
  });
  const market = await reader.buildAsOfMarketContext({
    symbols,
    asOfDate: input.asOfDate,
    inclusive: input.sameDayBarIncluded,
    count: input.historyCount ?? 60,
  });

  return {
    account: input.account,
    positions: input.positions,
    prices: market.prices,
    technicals: market.technicals,
    indices: market.indices,
    watchlist: input.watchlist,
    dataHealth: buildDataHealth({
      asOf: input.asOfDate,
      prices: market.prices,
      priceSymbolCount: symbols.length,
      indices: market.indices,
      watchlist: input.watchlist,
      includeWatchlist: Boolean(input.watchlist),
    }),
    webSearch: undefined, // can't bound a web search to the past
  };
}

/**
 * Prefetches four core index histories for faithful replay and exposes them as an
 * as-of source. This fixes the old replay degradation where live indices were
 * correctly omitted but no historical replacement existed.
 */
export async function prefetchAsOfIndexSource(
  config: AppConfig,
  asOfDate: string,
): Promise<AsOfIndexSource> {
  const provider = new TencentHistoryProvider({ timeoutMs: config.market.quoteTimeoutMs });
  const barsBySymbol: Record<string, KlineBar[]> = {};

  for (const definition of DEFAULT_ASOF_INDEX_DEFINITIONS) {
    try {
      barsBySymbol[toTencentIndexHistoryKey(definition)] = await provider.getDailyKlines(
        {
          symbol: definition.code,
          market: definition.market,
          name: definition.name,
        },
        {
          endDate: asOfDate,
          count: 240,
        },
      );
    } catch (error) {
      console.error(
        `(${definition.name} 指数历史拉取失败，重演中将降级：${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  return new KlineAsOfIndexSource({
    historyProvider: new FixtureHistoryProvider(barsBySymbol),
  });
}

function toTencentIndexHistoryKey(definition: { code: string; market: "SSE" | "SZSE" }): string {
  return `${definition.market === "SSE" ? "sh" : "sz"}${definition.code}`;
}

/**
 * Fetches each held symbol's daily history ONCE (up to `asOfDate`) and wraps it in an
 * in-memory provider, so a multi-node replay makes N network calls total, not N×nodes —
 * and the as-of reader's defensive filter still bounds every per-node read.
 */
export async function prefetchAsOfHistory(
  symbols: StockSymbolInfo[],
  config: AppConfig,
  asOfDate: string,
): Promise<FixtureHistoryProvider> {
  const provider = new TencentHistoryProvider({ timeoutMs: config.market.quoteTimeoutMs });
  const barsBySymbol: Record<string, KlineBar[]> = {};
  const seen = new Set<string>();

  for (const symbol of symbols) {
    if (seen.has(symbol.symbol)) {
      continue;
    }
    seen.add(symbol.symbol);
    try {
      barsBySymbol[symbol.symbol] = await provider.getDailyKlines(symbol, {
        endDate: asOfDate,
        count: 240,
      });
    } catch (error) {
      console.error(
        `(${symbol.symbol} 历史拉取失败，重演中将降级：${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  return new FixtureHistoryProvider(barsBySymbol);
}

/**
 * Builds the LIVE paper agent tools for the agentic chat loop: read tools backed by
 * the Tencent quote/history eyes + the stored ledger, and write tools backed by the
 * real deterministic hand (executePendingOrder, reviewer "auto-paper"). The model
 * pulls only what it needs and places paper trades itself; sizing/T+1/lot/cash stay in
 * code. Every fetch is best-effort (a failure degrades to null, never throws).
 */
export function buildLivePaperAgentTools(input: {
  config: AppConfig;
  memoryDir: string;
  /** Deterministic replay/ops backend (the caller wires executeAgentAction(paper_ops)). */
  executePaperOps?: (command: PaperOpsToolCommand) => Promise<string>;
}): PaperAgentTools {
  const { config, memoryDir } = input;
  const quoteProvider = new TencentQuoteProvider({ timeoutMs: config.market.quoteTimeoutMs });
  const historyProvider = new TencentHistoryProvider({ timeoutMs: config.market.quoteTimeoutMs });

  const getLatestPrice = async (symbol: string): Promise<number | null> => {
    try {
      const quotes = await quoteProvider.getQuotes([{ symbol, market: inferMarket(symbol) }]);
      return quotes[0]?.latestPrice ?? null;
    } catch {
      return null;
    }
  };

  const loadPortfolioView = async (): Promise<PaperPortfolioView> => {
    const { account, positions } = readBridgeAccountAndPositions(memoryDir);
    if (!account) {
      throw new Error("尚无模拟盘账户，请先建账户（例如：构建一个模拟盘账户）。");
    }
    let prices: Record<string, number> = {};
    try {
      const quotes = await quoteProvider.getQuotes(positions.map(toSymbolInfo));
      prices = Object.fromEntries(quotes.map((quote) => [quote.symbol, quote.latestPrice]));
    } catch {
      prices = {};
    }
    const valuation = calculatePortfolioValuation(account, positions, {
      prices,
      t1Enabled: config.trading.t1Enabled,
    });
    return {
      accountId: valuation.accountId,
      availableCash: valuation.cash.available,
      totalCash: valuation.cash.total,
      totalAssets: valuation.totalAssets,
      totalPositionMarketValue: valuation.totalPositionMarketValue,
      totalUnrealizedPnl: valuation.totalUnrealizedPnl,
      investedRatio: valuation.investedRatio,
      pricesAvailable: Object.keys(prices).length > 0,
      asOf: new Date().toISOString(),
      positions: valuation.positions.map((position) => ({
        symbol: position.symbol,
        market: position.market,
        name: position.name,
        quantity: position.quantity,
        sellableQuantity: position.sellableQuantity,
        costPrice: position.costPrice,
        latestPrice: position.latestPrice,
        marketValue: position.marketValue,
        unrealizedPnl: position.unrealizedPnl,
        unrealizedPnlRatio: position.unrealizedPnlRatio,
        positionRatio: position.positionRatio,
      })),
    };
  };

  const getQuote = async (symbol: string): Promise<PaperQuoteView | null> => {
    try {
      const quotes = await quoteProvider.getQuotes([{ symbol, market: inferMarket(symbol) }]);
      const quote = quotes[0];
      return quote
        ? { symbol: quote.symbol, market: quote.market, name: quote.name, price: quote.latestPrice }
        : null;
    } catch {
      return null;
    }
  };

  const getTechnicals = async (symbol: string): Promise<PaperTechnicalView | null> => {
    try {
      const indicators = await historyProvider.getDailyTechnicalIndicators(
        { symbol, market: inferMarket(symbol) },
        { count: 60 },
      );
      return {
        symbol: indicators.symbol,
        market: indicators.market,
        asOfDate: indicators.asOfDate,
        trend: indicators.trend,
        ma5: indicators.ma5,
        ma10: indicators.ma10,
        ma20: indicators.ma20,
        high60: indicators.high60,
        low60: indicators.low60,
        rangePosition60: indicators.rangePosition60,
      };
    } catch {
      return null;
    }
  };

  const deps = buildPaperAgentToolDeps({
    config,
    memoryDir,
    loadPortfolioView,
    getLatestPrice,
    getQuote,
    getTechnicals,
  });
  return buildPaperAgentTools({ ...deps, executePaperOps: input.executePaperOps });
}

/** Reads the current stored paper account + positions (used by the as-of replay). */
export function readBridgeAccountAndPositions(memoryDir: string): {
  account?: Account;
  positions: Position[];
} {
  const paths = createPortfolioMemoryPaths(memoryDir);
  return {
    account: readAccount(paths.accountPath),
    positions: readPositions(paths.positionsPath),
  };
}

function readAccount(accountPath: string): Account | undefined {
  try {
    return accountSchema.parse(JSON.parse(readFileSync(accountPath, "utf8")));
  } catch {
    return undefined;
  }
}

function readPositions(positionsPath: string): ReturnType<typeof positionsSchema.parse> {
  try {
    return positionsSchema.parse(JSON.parse(readFileSync(positionsPath, "utf8")));
  } catch {
    return [];
  }
}
