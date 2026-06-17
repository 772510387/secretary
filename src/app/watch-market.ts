import { z } from "zod";
import { auditEventSchema, type AuditEvent } from "../domain/audit/index.js";
import {
  calculateKlineTechnicalIndicators,
  klineTechnicalIndicatorsSchema,
  normalizeStockSymbol,
  quoteSnapshotSchema,
  stockSymbolInfoSchema,
  type KlineBar,
  type KlineTechnicalIndicators,
  type QuoteSnapshot,
  type StockSymbolInfo,
} from "../domain/market/index.js";
import {
  memoryRecentItemSchema,
  memorySearchResultSchema,
  type MemoryRecentItem,
  type MemorySearchResult,
} from "../domain/memory/index.js";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  stockMarketSchema,
  stockSymbolSchema,
  type JsonValue,
} from "../domain/shared/index.js";

export interface WatchMarketQuoteProvider {
  getQuotes(symbols: Array<string | StockSymbolInfo>): Promise<QuoteSnapshot[]>;
}

export interface WatchMarketHistoryProvider {
  getDailyTechnicalIndicators(
    symbol: string | StockSymbolInfo,
    options?: {
      count?: number;
      endDate?: string;
      adjustment?: "qfq" | "none";
    },
  ): Promise<KlineTechnicalIndicators>;
}

export interface WatchMarketMemoryRegistry {
  search(query: {
    query: string;
    categories?: Array<"rules" | "research" | "reports" | "proposals" | "logs">;
    limit?: number;
    snippetLength?: number;
  }): MemorySearchResult[];
  recent(query: { category: "research" | "reports"; limit?: number }): MemoryRecentItem[];
}

export const watchMarketQueryTypeSchema = z.enum(["market_overview", "symbol_snapshot"]);

export const watchMarketSymbolTargetSchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema.optional(),
    name: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const watchMarketInputSchema = z
  .object({
    requestId: identifierSchema.default("watch-market-on-demand"),
    requestedAt: isoDateTimeSchema.optional(),
    queryType: watchMarketQueryTypeSchema.default("market_overview"),
    query: z.string().trim().min(1).max(500).default("market overview on demand"),
    target: watchMarketSymbolTargetSchema.optional(),
    symbols: z.array(watchMarketSymbolTargetSchema).max(20).default([]),
    historyCount: z.number().int().positive().max(120).default(60),
    memorySearchQuery: z.string().trim().min(1).max(120).optional(),
    recentMemoryLimit: z.number().int().nonnegative().max(10).default(3),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.queryType === "symbol_snapshot" && input.target === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "symbol_snapshot requires target",
      });
    }
  });

export const watchMarketQuoteSummarySchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80),
    latestPrice: z.number().finite().nonnegative(),
    changePct: z.number().finite(),
    changeLabel: z.enum(["up", "down", "flat"]),
    receivedAt: isoDateTimeSchema,
    providerTime: isoDateTimeSchema.optional(),
  })
  .strict();

export const watchMarketIndicatorSummarySchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sampleSize: z.number().int().positive(),
    ma5: z.number().finite().nonnegative().optional(),
    ma10: z.number().finite().nonnegative().optional(),
    ma20: z.number().finite().nonnegative().optional(),
    high60: z.number().finite().nonnegative(),
    low60: z.number().finite().nonnegative(),
    rangePosition60: z.number().finite().min(0).max(1),
    trend: z.enum(["uptrend", "downtrend", "sideways", "insufficient_data"]),
  })
  .strict();

export const watchMarketMemoryContextSchema = z
  .object({
    searchResults: z
      .array(
        z
          .object({
            category: z.enum(["rules", "research", "reports", "proposals", "logs"]),
            relativePath: z.string().trim().min(1).max(320),
            title: z.string().trim().min(1).max(240).optional(),
            snippet: z.string().trim().min(1).max(800),
            updatedAt: isoDateTimeSchema,
          })
          .strict(),
      )
      .default([]),
    recentResearch: z
      .array(
        z
          .object({
            documentId: identifierSchema,
            title: z.string().trim().min(1).max(240),
            relativePath: z.string().trim().min(1).max(320),
            updatedAt: isoDateTimeSchema,
            metadata: jsonValueSchema.default({}),
          })
          .strict(),
      )
      .default([]),
    recentReports: z
      .array(
        z
          .object({
            documentId: identifierSchema,
            title: z.string().trim().min(1).max(240),
            relativePath: z.string().trim().min(1).max(320),
            updatedAt: isoDateTimeSchema,
            metadata: jsonValueSchema.default({}),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const watchMarketStructuredSummarySchema = z
  .object({
    headline: z.string().trim().min(1).max(500),
    tone: z.enum(["positive", "negative", "mixed", "no_data"]),
    quoteCount: z.number().int().nonnegative(),
    averageChangePct: z.number().finite().optional(),
    focusSymbols: z.array(stockSymbolInfoSchema).default([]),
    facts: z.array(z.string().trim().min(1).max(1000)).default([]),
    riskNotes: z.array(z.string().trim().min(1).max(1000)).default([]),
    contextGaps: z.array(z.string().trim().min(1).max(1000)).default([]),
    nextActions: z.array(z.string().trim().min(1).max(1000)).default([]),
  })
  .strict();

export const watchMarketReportDraftSchema = z
  .object({
    draftId: identifierSchema,
    title: z.string().trim().min(1).max(200),
    contentMarkdown: z.string().trim().min(1).max(50_000),
    executable: z.literal(false).default(false),
    brokerSubmissionAllowed: z.literal(false).default(false),
    accountWriteAllowed: z.literal(false).default(false),
    liveTradingAllowed: z.literal(false).default(false),
  })
  .strict();

export const watchMarketResultSchema = z
  .object({
    requestId: identifierSchema,
    queryType: watchMarketQueryTypeSchema,
    generatedAt: isoDateTimeSchema,
    quotes: z.array(watchMarketQuoteSummarySchema).default([]),
    indicators: z.array(watchMarketIndicatorSummarySchema).default([]),
    memoryContext: watchMarketMemoryContextSchema,
    summary: watchMarketStructuredSummarySchema,
    reportDraft: watchMarketReportDraftSchema,
    auditEvent: auditEventSchema,
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export interface WatchMarketDependencies {
  quoteProvider?: WatchMarketQuoteProvider;
  historyProvider?: WatchMarketHistoryProvider;
  memoryRegistry?: WatchMarketMemoryRegistry;
}

export type WatchMarketQueryType = z.infer<typeof watchMarketQueryTypeSchema>;
export type WatchMarketSymbolTarget = z.infer<typeof watchMarketSymbolTargetSchema>;
export type WatchMarketInput = z.infer<typeof watchMarketInputSchema>;
export type WatchMarketQuoteSummary = z.infer<typeof watchMarketQuoteSummarySchema>;
export type WatchMarketIndicatorSummary = z.infer<typeof watchMarketIndicatorSummarySchema>;
export type WatchMarketMemoryContext = z.infer<typeof watchMarketMemoryContextSchema>;
export type WatchMarketStructuredSummary = z.infer<typeof watchMarketStructuredSummarySchema>;
export type WatchMarketReportDraft = z.infer<typeof watchMarketReportDraftSchema>;
export type WatchMarketResult = z.infer<typeof watchMarketResultSchema>;

export async function runWatchMarketOnce(
  input: Partial<WatchMarketInput> = {},
  dependencies: WatchMarketDependencies = {},
): Promise<WatchMarketResult> {
  const request = watchMarketInputSchema.parse(input);
  const generatedAt = normalizeDate(request.requestedAt).toISOString();
  const symbols = resolveSymbols(request);
  const quoteProvider = dependencies.quoteProvider ?? createMockWatchMarketQuoteProvider();
  const historyProvider = dependencies.historyProvider ?? createMockWatchMarketHistoryProvider();
  const memoryRegistry = dependencies.memoryRegistry ?? createMockWatchMarketMemoryRegistry();
  const warnings: string[] = [];
  const quotes = await collectQuotes(quoteProvider, symbols, warnings);
  const indicators = await collectIndicators(historyProvider, symbols, request.historyCount, warnings);
  const memoryContext = collectMemoryContext(memoryRegistry, request, warnings);
  const summary = buildStructuredSummary({
    request,
    symbols,
    quotes,
    indicators,
    memoryContext,
    warnings,
  });
  const reportDraft = buildReportDraft({
    request,
    generatedAt,
    summary,
    quotes,
    indicators,
    memoryContext,
  });
  const auditEvent = buildAuditEvent({
    request,
    generatedAt,
    summary,
    quoteCount: quotes.length,
    indicatorCount: indicators.length,
    memoryContext,
  });

  return watchMarketResultSchema.parse({
    requestId: request.requestId,
    queryType: request.queryType,
    generatedAt,
    quotes,
    indicators,
    memoryContext,
    summary,
    reportDraft,
    auditEvent,
    metadata: sanitizeJsonObject({
      ...request.metadata,
      dataMode: dependencies.quoteProvider || dependencies.historyProvider || dependencies.memoryRegistry ? "injected" : "mock",
      quoteProviderUsed: true,
      historyProviderUsed: true,
      memoryRegistryUsed: true,
      brokerConnected: false,
      brainProviderCalled: false,
      directExecutionAllowed: false,
      liveTrading: false,
      warningCount: warnings.length,
    }),
  });
}

export function createMockWatchMarketQuoteProvider(
  quotes: readonly QuoteSnapshot[] = [],
  now: Date | string = "2026-06-15T02:00:00.000Z",
): WatchMarketQuoteProvider {
  const quoteMap = new Map(quotes.map((quote) => [symbolKey(quote), quoteSnapshotSchema.parse(quote)]));

  return {
    async getQuotes(symbols) {
      return symbols.map((symbol) => {
        const normalized = normalizeStockSymbol(symbol);
        return quoteMap.get(symbolKey(normalized)) ?? buildMockQuote(normalized, now);
      });
    },
  };
}

export function createMockWatchMarketHistoryProvider(
  indicators: readonly KlineTechnicalIndicators[] = [],
): WatchMarketHistoryProvider {
  const indicatorMap = new Map(
    indicators.map((indicator) => [
      symbolKey(indicator),
      klineTechnicalIndicatorsSchema.parse(indicator),
    ]),
  );

  return {
    async getDailyTechnicalIndicators(symbol) {
      const normalized = normalizeStockSymbol(symbol);
      return indicatorMap.get(symbolKey(normalized)) ?? buildMockIndicators(normalized);
    },
  };
}

export function createMockWatchMarketMemoryRegistry(input: {
  searchResults?: readonly MemorySearchResult[];
  recentResearch?: readonly MemoryRecentItem[];
  recentReports?: readonly MemoryRecentItem[];
} = {}): WatchMarketMemoryRegistry {
  return {
    search() {
      return [...(input.searchResults ?? [])].map((item) => memorySearchResultSchema.parse(item));
    },
    recent(query) {
      const source = query.category === "research" ? input.recentResearch : input.recentReports;
      return [...(source ?? [])]
        .map((item) => memoryRecentItemSchema.parse(item))
        .slice(0, query.limit ?? 10);
    },
  };
}

async function collectQuotes(
  provider: WatchMarketQuoteProvider,
  symbols: readonly StockSymbolInfo[],
  warnings: string[],
): Promise<WatchMarketQuoteSummary[]> {
  if (symbols.length === 0) {
    warnings.push("no_symbol_input");
    return [];
  }

  try {
    const quotes = await provider.getQuotes([...symbols]);
    return quotes.map(toQuoteSummary);
  } catch (error) {
    warnings.push(`quote_provider_failed:${sanitizeErrorMessage(error)}`);
    return [];
  }
}

async function collectIndicators(
  provider: WatchMarketHistoryProvider,
  symbols: readonly StockSymbolInfo[],
  historyCount: number,
  warnings: string[],
): Promise<WatchMarketIndicatorSummary[]> {
  const indicators: WatchMarketIndicatorSummary[] = [];

  for (const symbol of symbols) {
    try {
      indicators.push(
        toIndicatorSummary(
          await provider.getDailyTechnicalIndicators(symbol, {
            count: historyCount,
          }),
        ),
      );
    } catch (error) {
      warnings.push(`history_provider_failed:${symbol.market}:${symbol.symbol}:${sanitizeErrorMessage(error)}`);
    }
  }

  return indicators;
}

function collectMemoryContext(
  registry: WatchMarketMemoryRegistry,
  request: WatchMarketInput,
  warnings: string[],
): WatchMarketMemoryContext {
  try {
    const searchQuery = request.memorySearchQuery ?? buildDefaultMemorySearchQuery(request);
    const searchResults = registry.search({
      query: searchQuery,
      categories: ["rules", "research", "reports", "proposals", "logs"],
      limit: 5,
      snippetLength: 240,
    });
    const recentResearch = request.recentMemoryLimit > 0
      ? registry.recent({ category: "research", limit: request.recentMemoryLimit })
      : [];
    const recentReports = request.recentMemoryLimit > 0
      ? registry.recent({ category: "reports", limit: request.recentMemoryLimit })
      : [];

    return watchMarketMemoryContextSchema.parse({
      searchResults: searchResults.map((result) => ({
        category: result.document.category,
        relativePath: result.document.relativePath,
        title: result.document.title,
        snippet: sanitizeText(result.snippet),
        updatedAt: result.document.updatedAt,
      })),
      recentResearch: recentResearch.map(toRecentSummary),
      recentReports: recentReports.map(toRecentSummary),
    });
  } catch (error) {
    warnings.push(`memory_registry_failed:${sanitizeErrorMessage(error)}`);
    return watchMarketMemoryContextSchema.parse({
      searchResults: [],
      recentResearch: [],
      recentReports: [],
    });
  }
}

function buildStructuredSummary(input: {
  request: WatchMarketInput;
  symbols: readonly StockSymbolInfo[];
  quotes: readonly WatchMarketQuoteSummary[];
  indicators: readonly WatchMarketIndicatorSummary[];
  memoryContext: WatchMarketMemoryContext;
  warnings: readonly string[];
}): WatchMarketStructuredSummary {
  const averageChangePct = calculateAverageChangePct(input.quotes);
  const tone = classifyTone(input.quotes, averageChangePct);
  const facts = buildFacts(input.quotes, input.indicators, input.memoryContext);
  const contextGaps = buildContextGaps(input);
  const riskNotes = buildRiskNotes(input.quotes, input.indicators, input.warnings);
  const nextActions = [
    "Review the structured summary before asking for any research or proposal.",
    "Use ToolRuntime proposal paths for memory writes or trade intents; do not execute directly.",
  ];

  return watchMarketStructuredSummarySchema.parse({
    headline: buildHeadline(input.request, tone, input.quotes, averageChangePct),
    tone,
    quoteCount: input.quotes.length,
    averageChangePct,
    focusSymbols: input.symbols,
    facts,
    riskNotes,
    contextGaps,
    nextActions,
  });
}

function buildReportDraft(input: {
  request: WatchMarketInput;
  generatedAt: string;
  summary: WatchMarketStructuredSummary;
  quotes: readonly WatchMarketQuoteSummary[];
  indicators: readonly WatchMarketIndicatorSummary[];
  memoryContext: WatchMarketMemoryContext;
}): WatchMarketReportDraft {
  const title = input.request.queryType === "symbol_snapshot"
    ? `${input.summary.focusSymbols[0]?.symbol ?? "Symbol"} Snapshot Draft`
    : "Market Overview Draft";
  const lines = [
    `# ${title}`,
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## Summary",
    `- ${input.summary.headline}`,
    `- Tone: ${input.summary.tone}`,
    "",
    "## Quote Facts",
    ...(input.quotes.length > 0
      ? input.quotes.map(
          (quote) =>
            `- ${quote.market}:${quote.symbol} ${quote.name} latest ${quote.latestPrice}, change ${formatPct(quote.changePct)}.`,
        )
      : ["- No quote snapshot was available."]),
    "",
    "## Technical Context",
    ...(input.indicators.length > 0
      ? input.indicators.map(
          (indicator) =>
            `- ${indicator.market}:${indicator.symbol} trend ${indicator.trend}, range position ${indicator.rangePosition60}.`,
        )
      : ["- No technical indicator was available."]),
    "",
    "## Memory Context",
    `- Search result count: ${input.memoryContext.searchResults.length}.`,
    `- Recent research count: ${input.memoryContext.recentResearch.length}.`,
    `- Recent report count: ${input.memoryContext.recentReports.length}.`,
    "",
    "## Risk Notes",
    ...(input.summary.riskNotes.length > 0
      ? input.summary.riskNotes.map((note) => `- ${note}`)
      : ["- No deterministic risk note was generated."]),
    "",
    "## Next Actions",
    ...input.summary.nextActions.map((action) => `- ${action}`),
    "",
    "This draft is non-executable and must not be used as a broker order.",
  ];

  return watchMarketReportDraftSchema.parse({
    draftId: buildIdentifier("watch-market-draft", input.request.requestId),
    title,
    contentMarkdown: lines.join("\n"),
    executable: false,
    brokerSubmissionAllowed: false,
    accountWriteAllowed: false,
    liveTradingAllowed: false,
  });
}

function buildAuditEvent(input: {
  request: WatchMarketInput;
  generatedAt: string;
  summary: WatchMarketStructuredSummary;
  quoteCount: number;
  indicatorCount: number;
  memoryContext: WatchMarketMemoryContext;
}): AuditEvent {
  return auditEventSchema.parse({
    eventId: buildIdentifier("audit-watch-market", input.request.requestId),
    occurredAt: input.generatedAt,
    actor: {
      type: "user",
    },
    action: "read",
    subject: {
      type: "report",
      id: buildIdentifier("watch-market", input.request.requestId),
    },
    severity: "info",
    result: "success",
    message: `Built watch-market ${input.request.queryType} context for ${input.request.requestId}`,
    correlationId: input.request.requestId,
    metadata: sanitizeJsonObject({
      queryType: input.request.queryType,
      quoteCount: input.quoteCount,
      indicatorCount: input.indicatorCount,
      memorySearchResultCount: input.memoryContext.searchResults.length,
      recentResearchCount: input.memoryContext.recentResearch.length,
      recentReportCount: input.memoryContext.recentReports.length,
      tone: input.summary.tone,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
      brainProviderCalled: false,
    }),
  });
}

function resolveSymbols(request: WatchMarketInput): StockSymbolInfo[] {
  if (request.queryType === "symbol_snapshot") {
    return [normalizeWatchMarketTarget(request.target!)];
  }

  return request.symbols.map((symbol) => normalizeWatchMarketTarget(symbol));
}

function normalizeWatchMarketTarget(input: WatchMarketSymbolTarget): StockSymbolInfo {
  if (input.market !== undefined) {
    return stockSymbolInfoSchema.parse(input);
  }

  const normalized = normalizeStockSymbol(input.symbol);

  return stockSymbolInfoSchema.parse({
    ...normalized,
    name: input.name ?? normalized.name,
  });
}

function toQuoteSummary(quoteInput: QuoteSnapshot): WatchMarketQuoteSummary {
  const quote = quoteSnapshotSchema.parse(quoteInput);

  return watchMarketQuoteSummarySchema.parse({
    symbol: quote.symbol,
    market: quote.market,
    name: quote.name,
    latestPrice: quote.latestPrice,
    changePct: quote.changePct,
    changeLabel: quote.changePct > 0 ? "up" : quote.changePct < 0 ? "down" : "flat",
    receivedAt: quote.receivedAt,
    providerTime: quote.providerTime,
  });
}

function toIndicatorSummary(indicatorInput: KlineTechnicalIndicators): WatchMarketIndicatorSummary {
  const indicator = klineTechnicalIndicatorsSchema.parse(indicatorInput);

  return watchMarketIndicatorSummarySchema.parse({
    symbol: indicator.symbol,
    market: indicator.market,
    asOfDate: indicator.asOfDate,
    sampleSize: indicator.sampleSize,
    ma5: indicator.ma5,
    ma10: indicator.ma10,
    ma20: indicator.ma20,
    high60: indicator.high60,
    low60: indicator.low60,
    rangePosition60: indicator.rangePosition60,
    trend: indicator.trend,
  });
}

function toRecentSummary(itemInput: MemoryRecentItem): {
  documentId: string;
  title: string;
  relativePath: string;
  updatedAt: string;
  metadata: JsonValue;
} {
  const item = memoryRecentItemSchema.parse(itemInput);

  return {
    documentId: item.documentId,
    title: sanitizeText(item.title),
    relativePath: item.relativePath,
    updatedAt: item.updatedAt,
    metadata: sanitizeJsonValue(item.metadata),
  };
}

function buildDefaultMemorySearchQuery(request: WatchMarketInput): string {
  if (request.queryType === "symbol_snapshot" && request.target) {
    return `${request.target.symbol} ${request.target.name ?? ""}`.trim();
  }

  return request.query;
}

function buildFacts(
  quotes: readonly WatchMarketQuoteSummary[],
  indicators: readonly WatchMarketIndicatorSummary[],
  memoryContext: WatchMarketMemoryContext,
): string[] {
  const facts = [
    `Quote snapshots available: ${quotes.length}.`,
    `Technical indicator snapshots available: ${indicators.length}.`,
    `Memory search results available: ${memoryContext.searchResults.length}.`,
  ];

  if (quotes.length > 0) {
    const strongest = [...quotes].sort((left, right) => Math.abs(right.changePct) - Math.abs(left.changePct))[0]!;
    facts.push(`${strongest.market}:${strongest.symbol} has the largest absolute quote change at ${formatPct(strongest.changePct)}.`);
  }

  return facts;
}

function buildContextGaps(input: {
  symbols: readonly StockSymbolInfo[];
  quotes: readonly WatchMarketQuoteSummary[];
  indicators: readonly WatchMarketIndicatorSummary[];
  memoryContext: WatchMarketMemoryContext;
}): string[] {
  const gaps: string[] = [];

  if (input.symbols.length === 0) {
    gaps.push("No symbol input was supplied; index provider is not implemented in this use case.");
  }

  if (input.quotes.length < input.symbols.length) {
    gaps.push("Some requested symbols did not return quote snapshots.");
  }

  if (input.indicators.length < input.symbols.length) {
    gaps.push("Some requested symbols did not return technical indicators.");
  }

  if (input.memoryContext.searchResults.length === 0) {
    gaps.push("Memory keyword search returned no context.");
  }

  return gaps;
}

function buildRiskNotes(
  quotes: readonly WatchMarketQuoteSummary[],
  indicators: readonly WatchMarketIndicatorSummary[],
  warnings: readonly string[],
): string[] {
  const notes = new Set<string>();

  for (const quote of quotes) {
    if (quote.changePct <= -0.03) {
      notes.add(`${quote.market}:${quote.symbol} quote is down ${formatPct(quote.changePct)}; review downside risk manually.`);
    }

    if (quote.changePct >= 0.03) {
      notes.add(`${quote.market}:${quote.symbol} quote is up ${formatPct(quote.changePct)}; avoid chasing without follow-up research.`);
    }
  }

  for (const indicator of indicators) {
    if (indicator.trend === "downtrend") {
      notes.add(`${indicator.market}:${indicator.symbol} technical trend is downtrend.`);
    }

    if (indicator.rangePosition60 <= 0.15) {
      notes.add(`${indicator.market}:${indicator.symbol} is near the lower side of its 60-day range.`);
    }
  }

  for (const warning of warnings) {
    notes.add(`Input warning: ${warning}`);
  }

  return [...notes];
}

function buildHeadline(
  request: WatchMarketInput,
  tone: WatchMarketStructuredSummary["tone"],
  quotes: readonly WatchMarketQuoteSummary[],
  averageChangePct: number | undefined,
): string {
  if (quotes.length === 0) {
    return request.queryType === "symbol_snapshot"
      ? "No quote snapshot was available for the requested symbol."
      : "No quote snapshots were available for the market overview.";
  }

  const scope = request.queryType === "symbol_snapshot"
    ? `${quotes[0]!.market}:${quotes[0]!.symbol}`
    : `${quotes.length} symbol(s)`;
  const averageText = averageChangePct === undefined ? "n/a" : formatPct(averageChangePct);

  return `${scope} summary is ${tone}; average quote change is ${averageText}.`;
}

function calculateAverageChangePct(quotes: readonly WatchMarketQuoteSummary[]): number | undefined {
  if (quotes.length === 0) {
    return undefined;
  }

  return roundRatio(quotes.reduce((sum, quote) => sum + quote.changePct, 0) / quotes.length);
}

function classifyTone(
  quotes: readonly WatchMarketQuoteSummary[],
  averageChangePct: number | undefined,
): WatchMarketStructuredSummary["tone"] {
  if (quotes.length === 0 || averageChangePct === undefined) {
    return "no_data";
  }

  const hasUp = quotes.some((quote) => quote.changePct > 0);
  const hasDown = quotes.some((quote) => quote.changePct < 0);

  if (hasUp && hasDown) {
    return "mixed";
  }

  if (averageChangePct >= 0.01) {
    return "positive";
  }

  if (averageChangePct <= -0.01) {
    return "negative";
  }

  return "mixed";
}

function buildMockQuote(symbol: StockSymbolInfo, now: Date | string): QuoteSnapshot {
  const receivedAt = normalizeDate(now).toISOString();
  const base = symbol.symbol.startsWith("6") ? 10.5 : 12.3;
  const changePct = symbol.symbol.endsWith("1") ? 0.012 : -0.006;
  const previousClose = roundMoney(base / (1 + changePct));

  return quoteSnapshotSchema.parse({
    symbol: symbol.symbol,
    market: symbol.market,
    name: symbol.name ?? `Mock ${symbol.symbol}`,
    provider: "tencent",
    latestPrice: base,
    previousClose,
    openPrice: previousClose,
    highPrice: roundMoney(base * 1.01),
    lowPrice: roundMoney(base * 0.99),
    changeAmount: roundMoney(base - previousClose),
    changePct,
    volume: 100000,
    turnover: roundMoney(base * 100000),
    receivedAt,
    rawSymbol: `${symbol.market === "SSE" ? "sh" : "sz"}${symbol.symbol}`,
  });
}

function buildMockIndicators(symbol: StockSymbolInfo): KlineTechnicalIndicators {
  const bars: KlineBar[] = Array.from({ length: 20 }, (_, index) => {
    const close = roundMoney(10 + index * 0.05);
    const tradeDate = `2026-06-${String(index + 1).padStart(2, "0")}`;

    return {
      symbol: symbol.symbol,
      market: symbol.market,
      provider: "tencent",
      period: "1d",
      tradeDate,
      open: roundMoney(close - 0.02),
      close,
      high: roundMoney(close + 0.08),
      low: roundMoney(close - 0.08),
      volume: 100000 + index,
      turnover: roundMoney(close * (100000 + index)),
      rawSymbol: `${symbol.market === "SSE" ? "sh" : "sz"}${symbol.symbol}`,
    };
  });

  return calculateKlineTechnicalIndicators(bars);
}

function symbolKey(symbol: Pick<StockSymbolInfo, "market" | "symbol">): string {
  return `${symbol.market}:${symbol.symbol}`;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function roundMoney(value: number): number {
  return roundTo(value, 4);
}

function roundRatio(value: number): number {
  return roundTo(value, 6);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function buildIdentifier(prefix: string, value: string): string {
  const candidate = `${prefix}-${value}`;

  return candidate.length <= 128 ? candidate : candidate.slice(0, 128);
}

function normalizeDate(value: Date | string | undefined): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new WatchMarketError("Invalid watch-market date");
    }

    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new WatchMarketError(`Invalid watch-market date: ${value}`);
    }

    return parsed;
  }

  return new Date();
}

function sanitizeErrorMessage(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function sanitizeJsonObject(value: unknown): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return sanitizeJsonValue(value) as Record<string, JsonValue>;
}

function sanitizeJsonValue(value: unknown): JsonValue {
  if (typeof value === "string") {
    return sanitizeText(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeJsonValue);
  }

  if (typeof value === "object" && value !== null) {
    const output: Record<string, JsonValue> = {};

    for (const [key, child] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeJsonValue(child);
    }

    return output;
  }

  return null;
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|token|password|secret|account)\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]")
    .trim();
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-\s]/g, "_").toLowerCase();
  const compact = normalized.replace(/_/g, "");

  return (
    normalized === "token" ||
    normalized.endsWith("_token") ||
    normalized === "password" ||
    normalized.endsWith("_password") ||
    normalized === "secret" ||
    normalized.endsWith("_secret") ||
    normalized === "api_key" ||
    compact === "apikey" ||
    normalized === "account" ||
    normalized === "account_id" ||
    compact === "accountid"
  );
}

export class WatchMarketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchMarketError";
  }
}
