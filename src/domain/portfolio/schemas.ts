import { z } from "zod";
import {
  currencySchema,
  identifierSchema,
  isoDateTimeSchema,
  nonNegativeMoneySchema,
  nonNegativeQuantitySchema,
  positiveMoneySchema,
  positiveQuantitySchema,
  stockMarketSchema,
  stockSymbolSchema,
  tradeDateSchema,
} from "../shared/index.js";

export const accountTypeSchema = z.enum(["paper", "manual", "live"]);
export const accountStatusSchema = z.enum(["active", "suspended", "closed"]);

export const cashBalanceSchema = z
  .object({
    available: nonNegativeMoneySchema,
    frozen: nonNegativeMoneySchema,
  })
  .strict();

export const accountSchema = z
  .object({
    accountId: identifierSchema,
    type: accountTypeSchema,
    baseCurrency: currencySchema,
    initialCash: nonNegativeMoneySchema,
    cash: cashBalanceSchema,
    status: accountStatusSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict()
  .superRefine((account, context) => {
    if (Date.parse(account.updatedAt) < Date.parse(account.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedAt"],
        message: "updatedAt must be greater than or equal to createdAt",
      });
    }
  });

export const positionSchema = z
  .object({
    accountId: identifierSchema,
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80),
    quantity: nonNegativeQuantitySchema,
    availableQuantity: nonNegativeQuantitySchema,
    todayBuyQuantity: nonNegativeQuantitySchema,
    frozenQuantity: nonNegativeQuantitySchema,
    costPrice: nonNegativeMoneySchema,
    latestPrice: nonNegativeMoneySchema.optional(),
    currency: currencySchema,
    openedAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    /**
     * Trade date (Beijing, YYYY-MM-DD) of the most recent BUY that contributed to
     * todayBuyQuantity. Used by the T+1 cross-day rollover: once the trading date has
     * advanced past this, todayBuyQuantity settles into availableQuantity. Optional for
     * backward compatibility with positions persisted before this field existed.
     */
    lastBuyTradeDate: tradeDateSchema.optional(),
  })
  .strict()
  .superRefine((position, context) => {
    if (position.availableQuantity > position.quantity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["availableQuantity"],
        message: "availableQuantity cannot exceed quantity",
      });
    }

    if (position.todayBuyQuantity > position.quantity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["todayBuyQuantity"],
        message: "todayBuyQuantity cannot exceed quantity",
      });
    }

    if (position.frozenQuantity > position.quantity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["frozenQuantity"],
        message: "frozenQuantity cannot exceed quantity",
      });
    }

    if (position.availableQuantity + position.frozenQuantity > position.quantity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["availableQuantity"],
        message: "availableQuantity plus frozenQuantity cannot exceed quantity",
      });
    }

    if (Date.parse(position.updatedAt) < Date.parse(position.openedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedAt"],
        message: "updatedAt must be greater than or equal to openedAt",
      });
    }
  });

export const tradeSideSchema = z.enum(["BUY", "SELL"]);
export const tradeSourceSchema = z.enum(["paper", "manual", "broker"]);

export const tradeRecordSchema = z
  .object({
    tradeId: identifierSchema,
    accountId: identifierSchema,
    intentId: identifierSchema.optional(),
    orderId: identifierSchema.optional(),
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    side: tradeSideSchema,
    quantity: positiveQuantitySchema,
    price: positiveMoneySchema,
    grossAmount: positiveMoneySchema,
    fees: nonNegativeMoneySchema,
    tax: nonNegativeMoneySchema,
    netAmount: positiveMoneySchema,
    currency: currencySchema,
    tradeDate: tradeDateSchema,
    tradedAt: isoDateTimeSchema,
    source: tradeSourceSchema,
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type Account = z.infer<typeof accountSchema>;
export type CashBalance = z.infer<typeof cashBalanceSchema>;
export type Position = z.infer<typeof positionSchema>;
export type TradeRecord = z.infer<typeof tradeRecordSchema>;
export type TradeSide = z.infer<typeof tradeSideSchema>;
export type TradeSource = z.infer<typeof tradeSourceSchema>;
export type AccountType = z.infer<typeof accountTypeSchema>;
export type AccountStatus = z.infer<typeof accountStatusSchema>;

