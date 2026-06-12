import { z } from "zod";
import {
  currencySchema,
  identifierSchema,
  isoDateTimeSchema,
  nonNegativeMoneySchema,
  positiveMoneySchema,
  positiveQuantitySchema,
  stockMarketSchema,
  stockSymbolSchema,
} from "../shared/index.js";

export const orderSideSchema = z.enum(["BUY", "SELL"]);
export const orderTypeSchema = z.enum(["LIMIT"]);
export const orderStatusSchema = z.enum([
  "created",
  "validated",
  "submitted",
  "filled",
  "partial",
  "cancelled",
  "rejected",
]);
export const tradeIntentSourceSchema = z.enum(["user", "system", "brain", "strategy", "test"]);

export const tradeIntentSchema = z
  .object({
    intentId: identifierSchema,
    accountId: identifierSchema,
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80).optional(),
    side: orderSideSchema,
    quantity: positiveQuantitySchema,
    limitPrice: positiveMoneySchema,
    currency: currencySchema.default("CNY"),
    source: tradeIntentSourceSchema,
    reason: z.string().trim().max(1000).optional(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const orderRejectReasonSchema = z
  .object({
    code: identifierSchema,
    message: z.string().trim().min(1).max(1000),
  })
  .strict();

export const orderSchema = z
  .object({
    orderId: identifierSchema,
    intentId: identifierSchema,
    accountId: identifierSchema,
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80).optional(),
    side: orderSideSchema,
    type: orderTypeSchema,
    quantity: positiveQuantitySchema,
    limitPrice: positiveMoneySchema,
    currency: currencySchema,
    status: orderStatusSchema,
    source: tradeIntentSourceSchema,
    rejectReason: orderRejectReasonSchema.optional(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const executionReportSchema = z
  .object({
    executionId: identifierSchema,
    orderId: identifierSchema,
    intentId: identifierSchema,
    accountId: identifierSchema,
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    side: orderSideSchema,
    quantity: positiveQuantitySchema,
    price: positiveMoneySchema,
    grossAmount: positiveMoneySchema,
    fees: nonNegativeMoneySchema,
    tax: nonNegativeMoneySchema,
    netAmount: positiveMoneySchema,
    currency: currencySchema,
    tradeId: identifierSchema,
    executedAt: isoDateTimeSchema,
  })
  .strict();

export type OrderSide = z.infer<typeof orderSideSchema>;
export type OrderType = z.infer<typeof orderTypeSchema>;
export type OrderStatus = z.infer<typeof orderStatusSchema>;
export type TradeIntentSource = z.infer<typeof tradeIntentSourceSchema>;
export type TradeIntent = z.infer<typeof tradeIntentSchema>;
export type OrderRejectReason = z.infer<typeof orderRejectReasonSchema>;
export type Order = z.infer<typeof orderSchema>;
export type ExecutionReport = z.infer<typeof executionReportSchema>;

