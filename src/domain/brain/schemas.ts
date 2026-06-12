import { z } from "zod";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
} from "../shared/index.js";

export const brainProviderNameSchema = z.enum(["mock", "openai", "gemini", "dashscope"]);

export const brainTaskTypeSchema = z.enum([
  "pre_market_plan",
  "midday_review",
  "closing_review",
  "daily_reflection",
  "news_explanation",
  "trade_idea",
  "memory_proposal",
  "user_query",
  "research_summary",
]);

export const brainOutputFormatSchema = z.enum(["json", "markdown", "mixed"]);

export const toolPermissionSchema = z
  .object({
    toolName: identifierSchema,
    visibility: z.enum(["hidden", "read_only", "propose_only"]).default("read_only"),
    canExecute: z.literal(false).default(false),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const brainInputConstraintsSchema = z
  .object({
    locale: z.string().trim().min(1).default("zh-CN"),
    timezone: z.string().trim().min(1).default("Asia/Shanghai"),
    outputFormat: brainOutputFormatSchema.default("json"),
    schemaName: z.string().trim().min(1).max(128).optional(),
    maxSummaryLength: z.number().int().positive().max(20_000).optional(),
    toolPermissions: z.array(toolPermissionSchema).default([]),
  })
  .strict();

export const brainInputSchema = z
  .object({
    requestId: identifierSchema,
    taskType: brainTaskTypeSchema,
    prompt: z.string().trim().min(1).max(20_000),
    context: jsonValueSchema.default({}),
    constraints: brainInputConstraintsSchema.default({}),
    createdAt: isoDateTimeSchema.optional(),
  })
  .strict();

export const brainCitationSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    sourceType: z.enum(["user", "memory", "market", "research", "news", "system"]),
    url: z.string().url().optional(),
    retrievedAt: isoDateTimeSchema.optional(),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export const brainProposalTypeSchema = z.enum([
  "trade_intent_draft",
  "memory_write",
  "research_task",
  "notification",
]);

export const brainProposalSchema = z
  .object({
    proposalId: identifierSchema,
    type: brainProposalTypeSchema,
    title: z.string().trim().min(1).max(200),
    rationale: z.string().trim().min(1).max(2000),
    payload: jsonValueSchema,
    requiresReview: z.literal(true).default(true),
  })
  .strict();

export const brainOutputSchema = z
  .object({
    requestId: identifierSchema,
    provider: brainProviderNameSchema,
    model: z.string().trim().min(1).max(128),
    taskType: brainTaskTypeSchema,
    generatedAt: isoDateTimeSchema,
    summary: z.string().trim().min(1).max(20_000),
    structured: jsonValueSchema,
    citations: z.array(brainCitationSchema).default([]),
    confidence: z.number().finite().min(0).max(1),
    proposals: z.array(brainProposalSchema).default([]),
    rawText: z.string().trim().min(1).max(100_000).optional(),
  })
  .strict();

export type BrainProviderName = z.infer<typeof brainProviderNameSchema>;
export type BrainTaskType = z.infer<typeof brainTaskTypeSchema>;
export type BrainOutputFormat = z.infer<typeof brainOutputFormatSchema>;
export type ToolPermission = z.infer<typeof toolPermissionSchema>;
export type BrainInputConstraints = z.infer<typeof brainInputConstraintsSchema>;
export type BrainInput = z.infer<typeof brainInputSchema>;
export type BrainCitation = z.infer<typeof brainCitationSchema>;
export type BrainProposalType = z.infer<typeof brainProposalTypeSchema>;
export type BrainProposal = z.infer<typeof brainProposalSchema>;
export type BrainOutput = z.infer<typeof brainOutputSchema>;
