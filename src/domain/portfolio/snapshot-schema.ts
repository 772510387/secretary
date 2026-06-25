import { z } from "zod";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  nonNegativeMoneySchema,
  stockMarketSchema,
  stockSymbolSchema,
  tradeDateSchema,
} from "../shared/index.js";
import { accountSchema, positionSchema } from "./schemas.js";

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Pure UTC+8 date of an instant, without importing the scheduler (keeps domain pure). */
function beijingDateOf(isoInstant: string): string {
  const shifted = new Date(Date.parse(isoInstant) + BEIJING_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const beijingClockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");

/** Why the snapshot's mark-to-market price for a symbol is what it is — auditable, no-leak. */
export const snapshotPriceSourceSchema = z
  .object({
    /** as_of_close = real bar close <= asOfDate; cost_fallback = no as-of bar, valued at cost. */
    source: z.enum(["as_of_close", "cost_fallback"]),
    /** The source bar's tradeDate; required (and <= asOfDate) for as_of_close, absent for cost_fallback. */
    tradeDate: tradeDateSchema.optional(),
  })
  .strict();

/** Daily technicals as captured in a snapshot. ma fields are nullable (not omitted) for deterministic JSON. */
export const snapshotTechnicalSchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80).nullable(),
    asOfDate: tradeDateSchema,
    trend: z.enum(["uptrend", "downtrend", "sideways", "insufficient_data"]),
    ma5: nonNegativeMoneySchema.nullable(),
    ma10: nonNegativeMoneySchema.nullable(),
    ma20: nonNegativeMoneySchema.nullable(),
    high60: nonNegativeMoneySchema,
    low60: nonNegativeMoneySchema,
    rangePosition60: z.number().finite().min(0).max(1),
  })
  .strict();

export const snapshotIndexSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    latestPrice: nonNegativeMoneySchema,
    changePct: z.number().finite(),
    // Required: every persisted index must prove its as-of timing (no skippable check).
    asOfDate: tradeDateSchema,
  })
  .strict();

const snapshotPositionValuationSchema = z
  .object({
    accountId: identifierSchema,
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80),
    quantity: z.number().int().nonnegative(),
    sellableQuantity: z.number().int().nonnegative(),
    t1AvailableQuantity: z.number().int().nonnegative(),
    frozenQuantity: z.number().int().nonnegative(),
    todayBuyQuantity: z.number().int().nonnegative(),
    costPrice: nonNegativeMoneySchema,
    latestPrice: nonNegativeMoneySchema,
    costBasis: z.number().finite(),
    marketValue: z.number().finite(),
    unrealizedPnl: z.number().finite(),
    unrealizedPnlRatio: z.number().finite(),
    positionRatio: z.number().finite(),
  })
  .strict();

export const snapshotValuationSchema = z
  .object({
    accountId: identifierSchema,
    cash: z
      .object({
        available: z.number().finite(),
        frozen: z.number().finite(),
        total: z.number().finite(),
      })
      .strict(),
    positions: snapshotPositionValuationSchema.array(),
    totalPositionMarketValue: z.number().finite(),
    totalCostBasis: z.number().finite(),
    totalUnrealizedPnl: z.number().finite(),
    totalAssets: z.number().finite(),
    investedRatio: z.number().finite(),
  })
  .strict();

export const snapshotMarketSchema = z
  .object({
    /** True when at least one symbol was priced from a real as-of bar (not a cost fallback). */
    pricesAvailable: z.boolean(),
    /** symbol -> the mark-to-market price actually used (as-of close or, for degraded symbols, cost). */
    prices: z.record(nonNegativeMoneySchema),
    /** symbol -> provenance of its price (audits the no-look-ahead guarantee). */
    priceSources: z.record(snapshotPriceSourceSchema),
    technicals: snapshotTechnicalSchema.array(),
    indices: snapshotIndexSchema.array(),
  })
  .strict();

export const snapshotMetadataSchema = z
  .object({
    reason: z.enum(["replay", "daily_close", "manual"]),
    version: z.literal(1),
    generatedBy: z.literal("replay-runner"),
    degraded: z.boolean(),
    degradedReasons: z.array(z.string().trim().min(1).max(200)),
    /** symbol -> latest surviving bar tradeDate used (every value <= asOfDate). */
    historyAsOfDates: z.record(tradeDateSchema),
    indicesAvailable: z.boolean(),
    /** P0 only aligns to weekdays; holidays may emit nodes whose bars predate asOfDate. */
    calendar: z.literal("weekday_only"),
  })
  .strict();

export const pointInTimeSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: identifierSchema,
    accountId: identifierSchema,
    alarmId: z.string().trim().min(1).max(64),
    alarmType: z.string().trim().min(1).max(64),
    jobId: z.string().trim().min(1).max(128),
    asOfDate: tradeDateSchema,
    asOfTime: isoDateTimeSchema,
    beijingTime: beijingClockTimeSchema,
    /** True once the same trading day's bar is treated as settled (post-close nodes). */
    sameDayBarIncluded: z.boolean(),
    account: accountSchema,
    positions: positionSchema.array(),
    valuation: snapshotValuationSchema,
    market: snapshotMarketSchema,
    /** The exact buildAskContext-shaped bundle the brain would receive — assembled, never sent in P0. */
    brainContext: jsonValueSchema,
    metadata: snapshotMetadataSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const asOfMs = Date.parse(snapshot.asOfTime);

    // (1) asOfDate must be the Beijing date of asOfTime.
    if (beijingDateOf(snapshot.asOfTime) !== snapshot.asOfDate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["asOfDate"],
        message: `asOfDate ${snapshot.asOfDate} is not the Beijing date of asOfTime ${snapshot.asOfTime}`,
      });
    }

    // (2) No technical may be dated after asOfDate (YYYY-MM-DD lexical == chronological).
    snapshot.market.technicals.forEach((technical, index) => {
      if (technical.asOfDate > snapshot.asOfDate) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["market", "technicals", index, "asOfDate"],
          message: `look-ahead: technical asOfDate ${technical.asOfDate} > snapshot asOfDate ${snapshot.asOfDate}`,
        });
      }
    });

    // (3) No index may be dated after asOfDate.
    snapshot.market.indices.forEach((index, position) => {
      if (index.asOfDate > snapshot.asOfDate) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["market", "indices", position, "asOfDate"],
          message: `look-ahead: index asOfDate ${index.asOfDate} > snapshot asOfDate ${snapshot.asOfDate}`,
        });
      }
    });

    // (4) Every as-of-close price must derive from a bar dated <= asOfDate.
    for (const [symbol, provenance] of Object.entries(snapshot.market.priceSources)) {
      if (provenance.source === "as_of_close") {
        if (provenance.tradeDate === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["market", "priceSources", symbol, "tradeDate"],
            message: "as_of_close price must record its source bar tradeDate",
          });
        } else if (provenance.tradeDate > snapshot.asOfDate) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["market", "priceSources", symbol, "tradeDate"],
            message: `look-ahead: price bar ${provenance.tradeDate} > snapshot asOfDate ${snapshot.asOfDate}`,
          });
        }
      }
    }

    // (5) Every recorded history bar date must be <= asOfDate.
    for (const [symbol, date] of Object.entries(snapshot.metadata.historyAsOfDates)) {
      if (date > snapshot.asOfDate) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["metadata", "historyAsOfDates", symbol],
          message: `look-ahead: history bar ${date} > snapshot asOfDate ${snapshot.asOfDate}`,
        });
      }
    }

    // (6) Account/position state must not be from the future (instant compare, never lexical).
    if (Date.parse(snapshot.account.updatedAt) > asOfMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["account", "updatedAt"],
        message: `look-ahead: account.updatedAt ${snapshot.account.updatedAt} > asOfTime ${snapshot.asOfTime}`,
      });
    }
    snapshot.positions.forEach((position, index) => {
      if (Date.parse(position.updatedAt) > asOfMs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["positions", index, "updatedAt"],
          message: `look-ahead: position.updatedAt ${position.updatedAt} > asOfTime ${snapshot.asOfTime}`,
        });
      }
    });
  });

export type SnapshotPriceSource = z.infer<typeof snapshotPriceSourceSchema>;
export type SnapshotTechnical = z.infer<typeof snapshotTechnicalSchema>;
export type SnapshotIndex = z.infer<typeof snapshotIndexSchema>;
export type SnapshotMarket = z.infer<typeof snapshotMarketSchema>;
export type SnapshotValuation = z.infer<typeof snapshotValuationSchema>;
export type SnapshotMetadata = z.infer<typeof snapshotMetadataSchema>;
export type PointInTimeSnapshot = z.infer<typeof pointInTimeSnapshotSchema>;
