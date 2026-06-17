import { describe, expect, it } from "vitest";
import {
  createMockWatchMarketHistoryProvider,
  createMockWatchMarketMemoryRegistry,
  createMockWatchMarketQuoteProvider,
  runWatchMarketOnce,
  watchMarketResultSchema,
  type WatchMarketHistoryProvider,
  type WatchMarketMemoryRegistry,
  type WatchMarketQuoteProvider,
} from "../../src/app/index.js";
import {
  calculateKlineTechnicalIndicators,
  klineBarSchema,
  quoteSnapshotSchema,
  type KlineBar,
  type KlineTechnicalIndicators,
  type QuoteSnapshot,
  type StockSymbolInfo,
} from "../../src/domain/market/index.js";
import {
  memoryRecentItemSchema,
  memorySearchResultSchema,
  type MemoryRecentItem,
  type MemorySearchResult,
} from "../../src/domain/memory/index.js";

const now = "2026-06-15T02:00:00.000Z";

describe("runWatchMarketOnce", () => {
  it("builds a deterministic symbol snapshot from injected providers", async () => {
    const calls: {
      quoteSymbols: StockSymbolInfo[];
      historySymbols: StockSymbolInfo[];
      searchQueries: string[];
      recentCategories: string[];
    } = {
      quoteSymbols: [],
      historySymbols: [],
      searchQueries: [],
      recentCategories: [],
    };
    const quoteProvider: WatchMarketQuoteProvider = {
      async getQuotes(symbols) {
        calls.quoteSymbols = symbols as StockSymbolInfo[];

        return [
          makeQuote({
            symbol: "000001",
            market: "SZSE",
            name: "Ping An Bank",
            changePct: 0.025,
          }),
        ];
      },
    };
    const historyProvider: WatchMarketHistoryProvider = {
      async getDailyTechnicalIndicators(symbol) {
        calls.historySymbols.push(symbol as StockSymbolInfo);

        return makeIndicators({
          symbol: "000001",
          market: "SZSE",
          closes: Array.from({ length: 60 }, (_, index) => 10 + index * 0.1),
        });
      },
    };
    const memoryRegistry: WatchMarketMemoryRegistry = {
      search(query) {
        calls.searchQueries.push(query.query);

        return [
          makeSearchResult({
            snippet: "Recent note token=abc123 should be hidden.",
          }),
        ];
      },
      recent(query) {
        calls.recentCategories.push(query.category);

        return [
          makeRecentItem({
            category: query.category,
            metadata: {
              accountId: "paper-main",
              apiKey: "sk-test-secret-123456",
              safe: "summary only",
            },
          }),
        ];
      },
    };

    const result = await runWatchMarketOnce(
      {
        requestId: "watch-symbol-001",
        requestedAt: now,
        queryType: "symbol_snapshot",
        query: "How is 000001 now?",
        target: {
          symbol: "000001",
          name: "Ping An Bank",
        },
        metadata: {
          apiKey: "sk-input-secret-123456",
        },
      },
      {
        quoteProvider,
        historyProvider,
        memoryRegistry,
      },
    );

    expect(watchMarketResultSchema.safeParse(result).success).toBe(true);
    expect(calls.quoteSymbols).toEqual([
      {
        symbol: "000001",
        market: "SZSE",
        name: "Ping An Bank",
      },
    ]);
    expect(calls.historySymbols).toEqual(calls.quoteSymbols);
    expect(calls.searchQueries).toEqual(["000001 Ping An Bank"]);
    expect(calls.recentCategories).toEqual(["research", "reports"]);
    expect(result).toMatchObject({
      requestId: "watch-symbol-001",
      queryType: "symbol_snapshot",
      quotes: [
        {
          symbol: "000001",
          market: "SZSE",
          changeLabel: "up",
          changePct: 0.025,
        },
      ],
      indicators: [
        {
          symbol: "000001",
          market: "SZSE",
          trend: "uptrend",
        },
      ],
      summary: {
        tone: "positive",
        quoteCount: 1,
        focusSymbols: [
          {
            symbol: "000001",
            market: "SZSE",
            name: "Ping An Bank",
          },
        ],
      },
      reportDraft: {
        executable: false,
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
      },
      auditEvent: {
        action: "read",
        result: "success",
        metadata: {
          quoteCount: 1,
          indicatorCount: 1,
          memorySearchResultCount: 1,
          brokerSubmissionAllowed: false,
          accountWriteAllowed: false,
          liveTradingAllowed: false,
          brainProviderCalled: false,
        },
      },
      metadata: {
        dataMode: "injected",
        brokerConnected: false,
        brainProviderCalled: false,
        directExecutionAllowed: false,
        liveTrading: false,
        apiKey: "[redacted]",
      },
    });
    expect(result.reportDraft.contentMarkdown).toContain("non-executable");
    expect(JSON.stringify(result)).not.toContain("abc123");
    expect(JSON.stringify(result)).not.toContain("paper-main");
    expect(JSON.stringify(result)).not.toContain("sk-test-secret-123456");
    expect(JSON.stringify(result)).not.toContain("sk-input-secret-123456");
  });

  it("builds a market overview across requested A-share symbols", async () => {
    const quoteProvider = createMockWatchMarketQuoteProvider([
      makeQuote({
        symbol: "000001",
        market: "SZSE",
        changePct: 0.02,
      }),
      makeQuote({
        symbol: "600000",
        market: "SSE",
        changePct: -0.015,
      }),
    ]);
    const historyProvider = createMockWatchMarketHistoryProvider([
      makeIndicators({
        symbol: "000001",
        market: "SZSE",
        closes: Array.from({ length: 60 }, (_, index) => 10 + index * 0.1),
      }),
      makeIndicators({
        symbol: "600000",
        market: "SSE",
        closes: Array.from({ length: 60 }, (_, index) => 20 - index * 0.1),
      }),
    ]);

    const result = await runWatchMarketOnce(
      {
        requestId: "watch-overview-001",
        requestedAt: now,
        queryType: "market_overview",
        query: "market overview",
        symbols: [
          {
            symbol: "000001",
            market: "SZSE",
          },
          {
            symbol: "600000",
            market: "SSE",
          },
        ],
      },
      {
        quoteProvider,
        historyProvider,
        memoryRegistry: createMockWatchMarketMemoryRegistry(),
      },
    );

    expect(result.queryType).toBe("market_overview");
    expect(result.summary.tone).toBe("mixed");
    expect(result.summary.quoteCount).toBe(2);
    expect(result.summary.averageChangePct).toBe(0.0025);
    expect(result.indicators.map((indicator) => indicator.trend)).toEqual([
      "uptrend",
      "downtrend",
    ]);
    expect(result.reportDraft.title).toBe("Market Overview Draft");
    expect(result.summary.contextGaps).toContain("Memory keyword search returned no context.");
  });

  it("uses local mock providers by default without network, LLM, account, or broker access", async () => {
    const result = await runWatchMarketOnce({
      requestId: "watch-default-001",
      requestedAt: now,
      queryType: "symbol_snapshot",
      target: {
        symbol: "000001",
      },
    });

    expect(result.quotes).toHaveLength(1);
    expect(result.indicators).toHaveLength(1);
    expect(result.metadata).toMatchObject({
      dataMode: "mock",
      quoteProviderUsed: true,
      historyProviderUsed: true,
      memoryRegistryUsed: true,
      brokerConnected: false,
      brainProviderCalled: false,
      liveTrading: false,
    });
    expect(result.reportDraft.brokerSubmissionAllowed).toBe(false);
  });

  it("degrades provider failures into structured gaps and risk notes", async () => {
    const failingQuoteProvider: WatchMarketQuoteProvider = {
      async getQuotes() {
        throw new Error("quote token=secret-value failed");
      },
    };
    const failingHistoryProvider: WatchMarketHistoryProvider = {
      async getDailyTechnicalIndicators() {
        throw new Error("history apiKey=secret-value failed");
      },
    };
    const failingMemoryRegistry: WatchMarketMemoryRegistry = {
      search() {
        throw new Error("memory account=paper-main failed");
      },
      recent() {
        return [];
      },
    };

    const result = await runWatchMarketOnce(
      {
        requestId: "watch-failure-001",
        requestedAt: now,
        queryType: "symbol_snapshot",
        target: {
          symbol: "000001",
        },
      },
      {
        quoteProvider: failingQuoteProvider,
        historyProvider: failingHistoryProvider,
        memoryRegistry: failingMemoryRegistry,
      },
    );

    expect(result.summary.tone).toBe("no_data");
    expect(result.quotes).toEqual([]);
    expect(result.indicators).toEqual([]);
    expect(result.summary.contextGaps).toEqual([
      "Some requested symbols did not return quote snapshots.",
      "Some requested symbols did not return technical indicators.",
      "Memory keyword search returned no context.",
    ]);
    expect(result.summary.riskNotes).toEqual([
      "Input warning: quote_provider_failed:quote token=[redacted] failed",
      "Input warning: history_provider_failed:SZSE:000001:history apiKey=[redacted] failed",
      "Input warning: memory_registry_failed:memory account=[redacted] failed",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("paper-main");
  });

  it("rejects a symbol snapshot without a target", async () => {
    await expect(
      runWatchMarketOnce({
        requestId: "watch-invalid-001",
        requestedAt: now,
        queryType: "symbol_snapshot",
      }),
    ).rejects.toThrow(/symbol_snapshot requires target/);
  });
});

function makeQuote(overrides: {
  symbol: string;
  market: "SSE" | "SZSE";
  name?: string;
  changePct: number;
}): QuoteSnapshot {
  const latestPrice = overrides.market === "SSE" ? 12.5 : 10.5;
  const previousClose = round(latestPrice / (1 + overrides.changePct));

  return quoteSnapshotSchema.parse({
    symbol: overrides.symbol,
    market: overrides.market,
    name: overrides.name ?? `Mock ${overrides.symbol}`,
    provider: "tencent",
    latestPrice,
    previousClose,
    openPrice: previousClose,
    highPrice: round(latestPrice * 1.01),
    lowPrice: round(latestPrice * 0.99),
    changeAmount: round(latestPrice - previousClose),
    changePct: overrides.changePct,
    volume: 100000,
    turnover: round(latestPrice * 100000),
    receivedAt: now,
    rawSymbol: `${overrides.market === "SSE" ? "sh" : "sz"}${overrides.symbol}`,
  });
}

function makeIndicators(input: {
  symbol: string;
  market: "SSE" | "SZSE";
  closes: number[];
}): KlineTechnicalIndicators {
  const bars = input.closes.map((close, index) =>
    klineBarSchema.parse({
      symbol: input.symbol,
      market: input.market,
      provider: "tencent",
      period: "1d",
      tradeDate: makeTradeDate(index),
      open: close,
      close,
      high: close,
      low: close,
      volume: 1000 + index,
      rawSymbol: `${input.market === "SSE" ? "sh" : "sz"}${input.symbol}`,
    }),
  ) satisfies KlineBar[];

  return calculateKlineTechnicalIndicators(bars);
}

function makeTradeDate(index: number): string {
  const date = new Date(Date.UTC(2026, 3, 1 + index));
  return date.toISOString().slice(0, 10);
}

function makeSearchResult(overrides: {
  snippet: string;
}): MemorySearchResult {
  return memorySearchResultSchema.parse({
    document: {
      category: "research",
      documentId: "research-note-001",
      title: "Research Note",
      relativePath: "memory/research/research-note-001.json",
      filePath: "D:/tmp/memory/research/research-note-001.json",
      kind: "json",
      updatedAt: now,
      sizeBytes: 128,
      metadata: {},
    },
    path: "memory/research/research-note-001.json",
    summary: overrides.snippet,
    updatedAt: now,
    metadata: {},
    matchCount: 1,
    snippet: overrides.snippet,
  });
}

function makeRecentItem(input: {
  category: "research" | "reports";
  metadata: Record<string, unknown>;
}): MemoryRecentItem {
  return memoryRecentItemSchema.parse({
    category: input.category,
    documentId: `${input.category}-recent-001`,
    title: `${input.category} recent note`,
    path: `memory/${input.category}/recent-001.json`,
    summary: `${input.category} recent metadata summary`,
    relativePath: `memory/${input.category}/recent-001.json`,
    filePath: `D:/tmp/memory/${input.category}/recent-001.json`,
    tradingDate: "2026-06-15",
    generatedAt: now,
    updatedAt: now,
    metadata: input.metadata,
  });
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}
