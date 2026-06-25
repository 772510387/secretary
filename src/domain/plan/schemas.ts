import { z } from "zod";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  stockMarketSchema,
  stockSymbolSchema,
  tradeDateSchema,
} from "../shared/index.js";
import { tradeSideSchema } from "../portfolio/index.js";

/**
 * The daily stock-selection funnel as a persisted plan (P1).
 *
 * Layers: watchlist100 (a SNAPSHOT COPY of the 100 高关注池 as it stood when this plan
 * node ran — not a reference to the mutable watchlist file, so per-node decisions stay
 * reproducible) → shortlist10 (≤10 model-selected 潜力股) → pendingOrders (待买/待卖,
 * each a REFERENCE to a review-required proposal — this plan never holds executable orders).
 *
 * Safety: `liveTrading` is a hard literal `false`; the plan is an analysis artifact and
 * carries no execution authority. Actual fills happen only through the gated execution
 * path (P4), never from this object.
 */
export const planWatchlistEntrySchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80),
    rank: z.number().int().positive().nullable(),
  })
  .strict();

export const planShortlistEntrySchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80),
    rank: z.number().int().positive().nullable(),
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();

export const planPendingOrderStatusSchema = z.enum([
  "pending_review",
  "approved",
  "filled",
  "rejected",
  "cancelled",
]);

export const planPendingOrderSchema = z
  .object({
    /** Reference to the review-required TradeIntentReviewProposal; the plan holds no executable order. */
    proposalId: identifierSchema,
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    side: tradeSideSchema,
    status: planPendingOrderStatusSchema,
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();

export const dailyTradingPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: identifierSchema,
    tradingDate: tradeDateSchema,
    accountId: identifierSchema,
    /** Revision count: 0 = initial build, +1 each alarm node that revises the plan. */
    nodeSequence: z.number().int().nonnegative(),
    /** The alarm node that last revised this plan. */
    alarmType: z.string().trim().min(1).max(64),
    generatedAt: isoDateTimeSchema,
    watchlist100: planWatchlistEntrySchema.array(),
    shortlist10: planShortlistEntrySchema.array().max(10),
    pendingOrders: planPendingOrderSchema.array(),
    safety: z
      .object({
        liveTrading: z.literal(false),
        autoPaper: z.boolean(),
      })
      .strict(),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict()
  .superRefine((plan, context) => {
    // The shortlist must be drawn from the 100-pool (no smuggled-in symbols).
    const pool = new Set(plan.watchlist100.map((entry) => `${entry.market}:${entry.symbol}`));
    plan.shortlist10.forEach((entry, index) => {
      if (pool.size > 0 && !pool.has(`${entry.market}:${entry.symbol}`)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["shortlist10", index, "symbol"],
          message: `shortlist symbol ${entry.symbol} is not in the watchlist100 pool`,
        });
      }
    });
  });

/**
 * The model's structured selection output (P2). The model only PROPOSES symbols + sides;
 * the backend intersects them with the real 100-pool and turns orders into review-required
 * proposals. The model never sets executability, quantity authority, or approval.
 */
export const funnelSelectionSchema = z
  .object({
    shortlist: z
      .array(
        z
          .object({
            symbol: stockSymbolSchema,
            rationale: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(30),
    orders: z
      .array(
        z
          .object({
            symbol: stockSymbolSchema,
            side: tradeSideSchema,
            rationale: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();

export type PlanWatchlistEntry = z.infer<typeof planWatchlistEntrySchema>;
export type PlanShortlistEntry = z.infer<typeof planShortlistEntrySchema>;
export type PlanPendingOrderStatus = z.infer<typeof planPendingOrderStatusSchema>;
export type PlanPendingOrder = z.infer<typeof planPendingOrderSchema>;
export type DailyTradingPlan = z.infer<typeof dailyTradingPlanSchema>;
export type FunnelSelection = z.infer<typeof funnelSelectionSchema>;
