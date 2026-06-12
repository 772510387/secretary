import { z } from "zod";
import {
  currencySchema,
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  nonNegativeMoneySchema,
  positiveMoneySchema,
  positiveQuantitySchema,
  stockMarketSchema,
  stockSymbolSchema,
  tradeDateSchema,
} from "../shared/index.js";

export const researchProviderSchema = z.enum([
  "trading_agents_cn",
  "mock",
  "manual",
  "system",
]);

export const researchConclusionSchema = z.enum(["bullish", "bearish", "neutral", "mixed"]);

export const researchFindingCategorySchema = z.enum([
  "market",
  "technical",
  "fundamental",
  "news",
  "policy",
  "risk",
  "portfolio",
  "valuation",
  "sentiment",
  "other",
]);

export const researchSourceTypeSchema = z.enum([
  "trading_agents_cn",
  "market",
  "news",
  "filing",
  "research",
  "memory",
  "user",
  "system",
]);

export const researchTaskSchema = z
  .object({
    taskId: identifierSchema,
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80).optional(),
    tradingDate: tradeDateSchema,
    objective: z.string().trim().min(1).max(1000),
    context: jsonValueSchema.default({}),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const researchSourceSchema = z
  .object({
    sourceId: identifierSchema,
    sourceType: researchSourceTypeSchema,
    title: z.string().trim().min(1).max(300),
    url: z.string().url().optional(),
    observedAt: isoDateTimeSchema.optional(),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export const researchFindingSchema = z
  .object({
    findingId: identifierSchema,
    category: researchFindingCategorySchema,
    statement: z.string().trim().min(1).max(2000),
    evidence: z.array(z.string().trim().min(1).max(1000)).default([]),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

export const bullBearViewSchema = z
  .object({
    side: z.enum(["bull", "bear", "neutral"]),
    thesis: z.string().trim().min(1).max(2000),
    evidence: z.array(z.string().trim().min(1).max(1000)).default([]),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

export const riskFactorSchema = z
  .object({
    riskId: identifierSchema,
    severity: z.enum(["info", "watch", "warning", "critical"]),
    description: z.string().trim().min(1).max(2000),
    mitigation: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export const tradeIntentDraftSchema = z
  .object({
    draftId: identifierSchema,
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80).optional(),
    side: z.enum(["BUY", "SELL", "HOLD", "WATCH"]),
    quantity: positiveQuantitySchema.optional(),
    limitPrice: positiveMoneySchema.optional(),
    currency: currencySchema.default("CNY"),
    rationale: z.string().trim().min(1).max(2000),
    source: z.literal("research"),
    requiresReview: z.literal(true).default(true),
    executable: z.literal(false).default(false),
  })
  .strict();

export const researchReportSchema = z
  .object({
    reportId: identifierSchema,
    taskId: identifierSchema,
    provider: researchProviderSchema,
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80).optional(),
    tradingDate: tradeDateSchema,
    generatedAt: isoDateTimeSchema,
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(20_000),
    conclusion: researchConclusionSchema,
    confidence: z.number().finite().min(0).max(1),
    findings: z.array(researchFindingSchema).default([]),
    bullBearViews: z.array(bullBearViewSchema).default([]),
    riskFactors: z.array(riskFactorSchema).default([]),
    sources: z.array(researchSourceSchema).default([]),
    tradeIntentDrafts: z.array(tradeIntentDraftSchema).default([]),
    requiresHumanReview: z.literal(true).default(true),
    degraded: z.boolean().default(false),
    metadata: jsonValueSchema.default({}),
  })
  .strict();

export const tradingAgentsResearchAdapterOutputSchema = z
  .object({
    provider: z.literal("trading_agents_cn"),
    report: researchReportSchema,
    raw: jsonValueSchema.optional(),
  })
  .strict();

export type ResearchProvider = z.infer<typeof researchProviderSchema>;
export type ResearchConclusion = z.infer<typeof researchConclusionSchema>;
export type ResearchFindingCategory = z.infer<typeof researchFindingCategorySchema>;
export type ResearchSourceType = z.infer<typeof researchSourceTypeSchema>;
export type ResearchTask = z.infer<typeof researchTaskSchema>;
export type ResearchSource = z.infer<typeof researchSourceSchema>;
export type ResearchFinding = z.infer<typeof researchFindingSchema>;
export type BullBearView = z.infer<typeof bullBearViewSchema>;
export type RiskFactor = z.infer<typeof riskFactorSchema>;
export type TradeIntentDraft = z.infer<typeof tradeIntentDraftSchema>;
export type ResearchReport = z.infer<typeof researchReportSchema>;
export type TradingAgentsResearchAdapterOutput = z.infer<
  typeof tradingAgentsResearchAdapterOutputSchema
>;
