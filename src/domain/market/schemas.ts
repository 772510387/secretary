import { z } from "zod";
import {
  isoDateTimeSchema,
  nonNegativeMoneySchema,
  nonNegativeQuantitySchema,
  stockMarketSchema,
  stockSymbolSchema,
} from "../shared/index.js";

export const stockSymbolInfoSchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80).optional(),
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

export type StockSymbolInfo = z.infer<typeof stockSymbolInfoSchema>;
export type QuoteSnapshot = z.infer<typeof quoteSnapshotSchema>;

