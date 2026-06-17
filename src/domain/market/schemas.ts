import { z } from "zod";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  nonNegativeMoneySchema,
  nonNegativeQuantitySchema,
  stockMarketSchema,
  stockSymbolSchema,
  tradeDateSchema,
} from "../shared/index.js";

export const stockSymbolInfoSchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const indexIdSchema = z.enum([
  "sse_composite",
  "szse_component",
  "chinext",
  "star50",
]);

export const indexSnapshotSchema = z
  .object({
    indexId: indexIdSchema,
    code: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80),
    provider: z.literal("tencent"),
    latestPrice: nonNegativeMoneySchema,
    previousClose: nonNegativeMoneySchema.optional(),
    openPrice: nonNegativeMoneySchema.optional(),
    highPrice: nonNegativeMoneySchema.optional(),
    lowPrice: nonNegativeMoneySchema.optional(),
    changeAmount: z.number().finite().optional(),
    changePct: z.number().finite(),
    volume: nonNegativeQuantitySchema.optional(),
    turnover: nonNegativeMoneySchema.optional(),
    providerTime: isoDateTimeSchema.optional(),
    receivedAt: isoDateTimeSchema,
    rawSymbol: z.string().trim().min(1),
    tradingAllowed: z.literal(false).default(false),
  })
  .strict();

export const quoteSnapshotSchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80),
    provider: z.literal("tencent"),
    latestPrice: nonNegativeMoneySchema,
    previousClose: nonNegativeMoneySchema.optional(),
    openPrice: nonNegativeMoneySchema.optional(),
    highPrice: nonNegativeMoneySchema.optional(),
    lowPrice: nonNegativeMoneySchema.optional(),
    changeAmount: z.number().finite().optional(),
    changePct: z.number().finite(),
    volume: nonNegativeQuantitySchema.optional(),
    turnover: nonNegativeMoneySchema.optional(),
    providerTime: isoDateTimeSchema.optional(),
    receivedAt: isoDateTimeSchema,
    rawSymbol: z.string().trim().min(1),
  })
  .strict();

export const klinePeriodSchema = z.enum(["1d"]);

export const klineBarSchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    provider: z.literal("tencent"),
    period: klinePeriodSchema,
    tradeDate: tradeDateSchema,
    open: nonNegativeMoneySchema,
    close: nonNegativeMoneySchema,
    high: nonNegativeMoneySchema,
    low: nonNegativeMoneySchema,
    volume: nonNegativeQuantitySchema,
    turnover: nonNegativeMoneySchema.optional(),
    rawSymbol: z.string().trim().min(1),
  })
  .strict();

export const klineTrendLabelSchema = z.enum([
  "uptrend",
  "downtrend",
  "sideways",
  "insufficient_data",
]);

export const klineTechnicalIndicatorsSchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    period: klinePeriodSchema,
    asOfDate: tradeDateSchema,
    sampleSize: z.number().int().positive(),
    ma5: nonNegativeMoneySchema.optional(),
    ma10: nonNegativeMoneySchema.optional(),
    ma20: nonNegativeMoneySchema.optional(),
    high60: nonNegativeMoneySchema,
    low60: nonNegativeMoneySchema,
    rangePosition60: z.number().finite().min(0).max(1),
    trend: klineTrendLabelSchema,
  })
  .strict();

export const marketAnomalyTypeSchema = z.enum([
  "index_rapid_drop",
  "index_rapid_surge",
  "systemic_risk",
  "volume_surge",
  "volume_price_rise",
  "volume_stagnation",
  "low_liquidity",
  "suspended_or_no_volume",
]);

export const marketAnomalySeveritySchema = z.enum(["info", "watch", "warning", "critical"]);
export const marketAnomalySourceSchema = z.enum(["index_risk_radar", "volume_price_radar"]);
export const marketAnomalyTargetTypeSchema = z.enum(["index", "symbol", "system"]);

export const marketAnomalySchema = z
  .object({
    anomalyId: identifierSchema,
    anomalyType: marketAnomalyTypeSchema,
    severity: marketAnomalySeveritySchema,
    targetType: marketAnomalyTargetTypeSchema,
    occurredAt: isoDateTimeSchema,
    source: marketAnomalySourceSchema,
    message: z.string().trim().min(1).max(1000),
    indexId: indexIdSchema.optional(),
    symbol: stockSymbolSchema.optional(),
    code: stockSymbolSchema.optional(),
    market: stockMarketSchema.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    currentValue: z.number().finite().nonnegative().optional(),
    previousValue: z.number().finite().nonnegative().optional(),
    changePct: z.number().finite().optional(),
    threshold: z.number().finite().nonnegative().optional(),
    lookbackMs: z.number().int().nonnegative().optional(),
    sampleSize: z.number().int().positive().optional(),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export type StockSymbolInfo = z.infer<typeof stockSymbolInfoSchema>;
export type IndexId = z.infer<typeof indexIdSchema>;
export type IndexSnapshot = z.infer<typeof indexSnapshotSchema>;
export type QuoteSnapshot = z.infer<typeof quoteSnapshotSchema>;
export type KlinePeriod = z.infer<typeof klinePeriodSchema>;
export type KlineBar = z.infer<typeof klineBarSchema>;
export type KlineTrendLabel = z.infer<typeof klineTrendLabelSchema>;
export type KlineTechnicalIndicators = z.infer<typeof klineTechnicalIndicatorsSchema>;
export type MarketAnomalyType = z.infer<typeof marketAnomalyTypeSchema>;
export type MarketAnomalySeverity = z.infer<typeof marketAnomalySeveritySchema>;
export type MarketAnomalySource = z.infer<typeof marketAnomalySourceSchema>;
export type MarketAnomalyTargetType = z.infer<typeof marketAnomalyTargetTypeSchema>;
export type MarketAnomaly = z.infer<typeof marketAnomalySchema>;
