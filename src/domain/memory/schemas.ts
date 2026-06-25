import { z } from "zod";
import {
  currencySchema,
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  positiveMoneySchema,
  positiveQuantitySchema,
  stockMarketSchema,
  stockSymbolSchema,
} from "../shared/index.js";
import { researchProviderSchema } from "../research/index.js";

export const proposalStatusSchema = z.enum([
  "pending_review",
  "approved",
  "rejected",
  "applied",
]);

export const proposalTypeSchema = z.enum(["trade_intent_review", "memory_write_review"]);

export const proposalActorSchema = z
  .object({
    type: z.enum(["user", "system"]),
    id: identifierSchema.optional(),
  })
  .strict();

export const researchReportProposalSourceSchema = z
  .object({
    sourceType: z.literal("research_report"),
    reportId: identifierSchema,
    taskId: identifierSchema,
    draftId: identifierSchema,
    provider: researchProviderSchema,
  })
  .strict();

export const brainToolRequestProposalSourceSchema = z
  .object({
    sourceType: z.literal("brain_tool_request"),
    requestId: identifierSchema,
    toolType: z.literal("propose_trade_intent"),
  })
  .strict();

export const proposalSourceSchema = z.union([
  researchReportProposalSourceSchema,
  brainToolRequestProposalSourceSchema,
]);

export const memoryWriteTypeSchema = z.enum([
  "daily_reflection",
  "experience_summary",
  "topic_logic",
  "error_pattern",
  "log_summary",
  "soft_threshold_adjustment",
  "main_board_rule_change",
  "t1_rule_change",
  "lot_size_rule_change",
  "stop_loss_rule_change",
  "position_limit_rule_change",
  "live_trading_change",
  "broker_boundary_change",
  "audit_deletion",
  "secret_write",
  "risk_bypass",
  "direct_order",
]);

export const memoryWriteOperationSchema = z.enum([
  "create",
  "append",
  "update",
  "delete",
  "overwrite",
]);

export const memoryWriteTargetCategorySchema = z.enum([
  "daily_logs",
  "weekly_reviews",
  "monthly_reviews",
  "yearly_reviews",
  "long_term",
  "rules",
  "proposals",
  "logs",
  "research",
  "reports",
  "config",
  "portfolio",
  "audit",
  "secrets",
  "broker",
  "orders",
]);

export const memoryRegistryCategorySchema = z.enum([
  "daily_logs",
  "weekly_reviews",
  "monthly_reviews",
  "yearly_reviews",
  "long_term",
  "history",
  "rules",
  "research",
  "reports",
  "proposals",
  "logs",
]);

export const memoryDocumentKindSchema = z.enum([
  "markdown",
  "json",
  "jsonl",
  "text",
  "unknown",
]);

export const memoryDocumentSchema = z
  .object({
    category: memoryRegistryCategorySchema,
    documentId: identifierSchema,
    title: z.string().trim().min(1).max(240).optional(),
    relativePath: z.string().trim().min(1).max(320),
    filePath: z.string().trim().min(1).max(500),
    kind: memoryDocumentKindSchema,
    updatedAt: isoDateTimeSchema,
    sizeBytes: z.number().int().nonnegative(),
    metadata: jsonValueSchema.default({}),
  })
  .strict();

export const memoryRegistryQuerySchema = z
  .object({
    category: memoryRegistryCategorySchema.optional(),
    categories: z.array(memoryRegistryCategorySchema).min(1).optional(),
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.from !== undefined &&
      query.to !== undefined &&
      Date.parse(query.from) > Date.parse(query.to)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "from must be earlier than or equal to to",
      });
    }
  });

export const memorySearchQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(120),
    category: memoryRegistryCategorySchema.optional(),
    categories: z.array(memoryRegistryCategorySchema).min(1).optional(),
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
    limit: z.number().int().positive().max(50).default(10),
    snippetLength: z.number().int().min(80).max(500).default(240),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.from !== undefined &&
      query.to !== undefined &&
      Date.parse(query.from) > Date.parse(query.to)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "from must be earlier than or equal to to",
      });
    }
  });

export const memorySearchResultSchema = z
  .object({
    document: memoryDocumentSchema,
    path: z.string().trim().min(1).max(320),
    summary: z.string().trim().min(1).max(800),
    updatedAt: isoDateTimeSchema,
    metadata: jsonValueSchema.default({}),
    matchCount: z.number().int().positive(),
    snippet: z.string().trim().min(1).max(800),
  })
  .strict();

export const memoryRecentCategorySchema = z.enum(["research", "reports"]);

export const memoryRecentQuerySchema = z
  .object({
    category: memoryRecentCategorySchema,
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
    limit: z.number().int().positive().max(50).default(10),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.from !== undefined &&
      query.to !== undefined &&
      Date.parse(query.from) > Date.parse(query.to)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "from must be earlier than or equal to to",
      });
    }
  });

export const memoryRecentItemSchema = z
  .object({
    category: memoryRecentCategorySchema,
    documentId: identifierSchema,
    title: z.string().trim().min(1).max(240),
    path: z.string().trim().min(1).max(320),
    summary: z.string().trim().min(1).max(800),
    relativePath: z.string().trim().min(1).max(320),
    filePath: z.string().trim().min(1).max(500),
    tradingDate: z.string().trim().min(1).max(20).optional(),
    generatedAt: isoDateTimeSchema.optional(),
    updatedAt: isoDateTimeSchema,
    metadata: jsonValueSchema.default({}),
  })
  .strict();

export const memoryWriteRequestSourceSchema = z
  .object({
    sourceType: z.enum(["brain", "system", "user", "scheduler", "research_report", "report"]),
    sourceId: identifierSchema.optional(),
  })
  .strict();

export const memoryWriteRiskControlsSchema = z
  .object({
    weakensHardRule: z.boolean().default(false),
    touchesLiveTrading: z.boolean().default(false),
    touchesBrokerBoundary: z.boolean().default(false),
    touchesAccountOrOrder: z.boolean().default(false),
    containsSecret: z.boolean().default(false),
    deletesAudit: z.boolean().default(false),
    bypassesRisk: z.boolean().default(false),
    convertsModelOutputToOrder: z.boolean().default(false),
  })
  .strict();

export const softThresholdChangeSchema = z
  .object({
    key: identifierSchema,
    currentValue: z.number().finite(),
    proposedValue: z.number().finite(),
    minValue: z.number().finite(),
    maxValue: z.number().finite(),
  })
  .strict()
  .superRefine((change, context) => {
    if (change.minValue > change.maxValue) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minValue"],
        message: "minValue must be less than or equal to maxValue",
      });
    }
  });

export const memoryWriteRequestSchema = z
  .object({
    requestId: identifierSchema,
    requestedAt: isoDateTimeSchema,
    requestedBy: memoryWriteRequestSourceSchema,
    writeType: memoryWriteTypeSchema,
    operation: memoryWriteOperationSchema,
    targetCategory: memoryWriteTargetCategorySchema,
    targetPath: z.string().trim().min(1).max(240),
    title: z.string().trim().min(1).max(160),
    contentSummary: z.string().trim().min(1).max(1000),
    evidenceRefs: z.array(z.string().trim().min(1).max(240)).default([]),
    softThresholdChange: softThresholdChangeSchema.optional(),
    riskControls: memoryWriteRiskControlsSchema.default({
      weakensHardRule: false,
      touchesLiveTrading: false,
      touchesBrokerBoundary: false,
      touchesAccountOrOrder: false,
      containsSecret: false,
      deletesAudit: false,
      bypassesRisk: false,
      convertsModelOutputToOrder: false,
    }),
    metadata: jsonValueSchema.default({}),
  })
  .strict();

export const memoryWritePolicyDecisionStatusSchema = z.enum([
  "allow",
  "proposal_required",
  "reject",
]);

export const memoryWritePolicyReasonSchema = z.enum([
  "auto_memory_type",
  "soft_threshold_within_bounds",
  "soft_threshold_missing_evidence",
  "soft_threshold_missing_bounds",
  "soft_threshold_out_of_bounds",
  "hard_rule_change",
  "hard_rule_weakening",
  "protected_target",
  "dangerous_operation",
  "secret_write",
  "audit_deletion",
  "risk_bypass",
  "account_or_order_write",
  "direct_order",
  "live_trading_boundary",
  "broker_boundary",
]);

export const memoryWritePolicyDecisionSchema = z
  .object({
    status: memoryWritePolicyDecisionStatusSchema,
    reasons: z.array(memoryWritePolicyReasonSchema).min(1),
    requiresAudit: z.literal(true).default(true),
    requiresProposal: z.boolean(),
    autoApplyAllowed: z.boolean(),
    targetCategory: memoryWriteTargetCategorySchema,
    targetPath: z.string().trim().min(1).max(240),
    metadata: jsonValueSchema.default({}),
  })
  .strict();

export const memoryWriteProposalSourceSchema = z
  .object({
    sourceType: z.literal("memory_write_request"),
    requestId: identifierSchema,
    requestedBy: memoryWriteRequestSourceSchema,
    writeType: memoryWriteTypeSchema,
  })
  .strict();

export const proposalExecutionGuardSchema = z
  .object({
    requiresManualReview: z.literal(true).default(true),
    executable: z.literal(false).default(false),
    brokerSubmissionAllowed: z.literal(false).default(false),
    accountWriteAllowed: z.literal(false).default(false),
    liveTradingAllowed: z.literal(false).default(false),
  })
  .strict();

export const approvalDecisionSchema = z.enum(["approved", "rejected"]);

export const approvalRecordSchema = z
  .object({
    approvalId: identifierSchema,
    proposalId: identifierSchema,
    decision: approvalDecisionSchema,
    reviewer: proposalActorSchema,
    reviewedAt: isoDateTimeSchema,
    operatorSessionId: identifierSchema,
    riskSnapshotRef: z.string().trim().min(1).max(240),
    reviewNote: z.string().trim().min(1).max(1000).optional(),
    requestId: identifierSchema.optional(),
    metadata: jsonValueSchema.default({}),
  })
  .strict();

export const tradeIntentReviewProposalSchema = z
  .object({
    proposalId: identifierSchema,
    proposalType: z.literal("trade_intent_review"),
    status: proposalStatusSchema.default("pending_review"),
    source: proposalSourceSchema,
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80).optional(),
    side: z.enum(["BUY", "SELL", "HOLD", "WATCH"]),
    quantity: positiveQuantitySchema.optional(),
    limitPrice: positiveMoneySchema.optional(),
    currency: currencySchema.default("CNY"),
    rationale: z.string().trim().min(1).max(2000),
    reviewReason: z.string().trim().min(1).max(1000),
    executionGuard: proposalExecutionGuardSchema.default({
      requiresManualReview: true,
      executable: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    }),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    createdBy: proposalActorSchema.default({
      type: "system",
      id: "research-proposal-converter",
    }),
    reviewedAt: isoDateTimeSchema.optional(),
    reviewedBy: proposalActorSchema.optional(),
    reviewNote: z.string().trim().min(1).max(1000).optional(),
    metadata: jsonValueSchema.default({}),
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.status === "pending_review") {
      if (proposal.reviewedAt !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reviewedAt"],
          message: "pending_review proposal must not have reviewedAt",
        });
      }

      if (proposal.reviewedBy !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reviewedBy"],
          message: "pending_review proposal must not have reviewedBy",
        });
      }
    }

    if (Date.parse(proposal.updatedAt) < Date.parse(proposal.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedAt"],
        message: "updatedAt must be greater than or equal to createdAt",
      });
    }
  });

export const memoryWriteReviewProposalSchema = z
  .object({
    proposalId: identifierSchema,
    proposalType: z.literal("memory_write_review"),
    status: proposalStatusSchema.default("pending_review"),
    source: memoryWriteProposalSourceSchema,
    request: memoryWriteRequestSchema,
    decision: memoryWritePolicyDecisionSchema,
    reviewReason: z.string().trim().min(1).max(1000),
    executionGuard: proposalExecutionGuardSchema.default({
      requiresManualReview: true,
      executable: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    }),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    createdBy: proposalActorSchema.default({
      type: "system",
      id: "memory-write-policy",
    }),
    reviewedAt: isoDateTimeSchema.optional(),
    reviewedBy: proposalActorSchema.optional(),
    reviewNote: z.string().trim().min(1).max(1000).optional(),
    metadata: jsonValueSchema.default({}),
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.status === "pending_review") {
      if (proposal.reviewedAt !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reviewedAt"],
          message: "pending_review proposal must not have reviewedAt",
        });
      }

      if (proposal.reviewedBy !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reviewedBy"],
          message: "pending_review proposal must not have reviewedBy",
        });
      }
    }

    if (proposal.decision.status !== "proposal_required") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision", "status"],
        message: "memory_write_review proposal requires a proposal_required decision",
      });
    }

    if (Date.parse(proposal.updatedAt) < Date.parse(proposal.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedAt"],
        message: "updatedAt must be greater than or equal to createdAt",
      });
    }
  });

export const reviewProposalSchema = z.union([
  tradeIntentReviewProposalSchema,
  memoryWriteReviewProposalSchema,
]);

export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type ProposalType = z.infer<typeof proposalTypeSchema>;
export type ProposalActor = z.infer<typeof proposalActorSchema>;
export type ResearchReportProposalSource = z.infer<typeof researchReportProposalSourceSchema>;
export type BrainToolRequestProposalSource = z.infer<typeof brainToolRequestProposalSourceSchema>;
export type ProposalSource = z.infer<typeof proposalSourceSchema>;
export type ProposalExecutionGuard = z.infer<typeof proposalExecutionGuardSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
export type TradeIntentReviewProposal = z.infer<typeof tradeIntentReviewProposalSchema>;
export type MemoryWriteType = z.infer<typeof memoryWriteTypeSchema>;
export type MemoryWriteOperation = z.infer<typeof memoryWriteOperationSchema>;
export type MemoryWriteTargetCategory = z.infer<typeof memoryWriteTargetCategorySchema>;
export type MemoryRegistryCategory = z.infer<typeof memoryRegistryCategorySchema>;
export type MemoryDocumentKind = z.infer<typeof memoryDocumentKindSchema>;
export type MemoryDocument = z.infer<typeof memoryDocumentSchema>;
export type MemoryRegistryQuery = z.infer<typeof memoryRegistryQuerySchema>;
export type MemorySearchQuery = z.infer<typeof memorySearchQuerySchema>;
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>;
export type MemoryRecentCategory = z.infer<typeof memoryRecentCategorySchema>;
export type MemoryRecentQuery = z.infer<typeof memoryRecentQuerySchema>;
export type MemoryRecentItem = z.infer<typeof memoryRecentItemSchema>;
export type MemoryWriteRequestSource = z.infer<typeof memoryWriteRequestSourceSchema>;
export type MemoryWriteRiskControls = z.infer<typeof memoryWriteRiskControlsSchema>;
export type SoftThresholdChange = z.infer<typeof softThresholdChangeSchema>;
export type MemoryWriteRequest = z.infer<typeof memoryWriteRequestSchema>;
export type MemoryWritePolicyDecisionStatus = z.infer<typeof memoryWritePolicyDecisionStatusSchema>;
export type MemoryWritePolicyReason = z.infer<typeof memoryWritePolicyReasonSchema>;
export type MemoryWritePolicyDecision = z.infer<typeof memoryWritePolicyDecisionSchema>;
export type MemoryWriteProposalSource = z.infer<typeof memoryWriteProposalSourceSchema>;
export type MemoryWriteReviewProposal = z.infer<typeof memoryWriteReviewProposalSchema>;
export type ReviewProposal = z.infer<typeof reviewProposalSchema>;
