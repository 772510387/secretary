import { z } from "zod";
import {
  auditEventSchema,
  type AuditEvent,
} from "../audit/index.js";
import {
  createMemoryWriteReviewProposal,
  evaluateMemoryWritePolicy,
  memoryRegistryCategorySchema,
  memorySearchQuerySchema,
  memoryWriteRequestSchema,
  reviewProposalSchema,
  tradeIntentReviewProposalSchema,
  type MemoryWritePolicyDecision,
  type ReviewProposal,
  type TradeIntentReviewProposal,
} from "../memory/index.js";
import {
  currencySchema,
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  positiveMoneySchema,
  positiveQuantitySchema,
  stockMarketSchema,
  stockSymbolSchema,
  tradeDateSchema,
  type JsonValue,
} from "../shared/index.js";

export const allowedToolRuntimeToolTypes = [
  "read_memory",
  "search_memory",
  "get_quote",
  "fetch_history",
  "propose_memory_write",
  "propose_trade_intent",
] as const;

export const forbiddenToolRuntimeToolTypes = [
  "execute_order",
  "write_account",
  "overwrite_rule",
  "enable_live_trading",
  "read_secret",
] as const;

export const toolRuntimeAllowedToolTypeSchema = z.enum(allowedToolRuntimeToolTypes);
export const toolRuntimeForbiddenToolTypeSchema = z.enum(forbiddenToolRuntimeToolTypes);

export const toolRuntimeRequesterSchema = z
  .object({
    type: z.enum(["brain", "system", "user"]),
    id: identifierSchema.optional(),
  })
  .strict();

export const toolRuntimeRequestSchema = z
  .object({
    requestId: identifierSchema,
    requestedAt: isoDateTimeSchema.optional(),
    requestedBy: toolRuntimeRequesterSchema.default({ type: "brain" }),
    toolType: z.string().trim().min(1).max(80),
    reason: z.string().trim().min(1).max(1000),
    payload: jsonValueSchema.default({}),
  })
  .strict();

export const readMemoryToolPayloadSchema = z
  .object({
    category: memoryRegistryCategorySchema,
    relativePath: z.string().trim().min(1).max(320),
  })
  .strict();

export const searchMemoryToolPayloadSchema = memorySearchQuerySchema;

export const getQuoteToolPayloadSchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema.optional(),
  })
  .strict();

export const fetchHistoryToolPayloadSchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema.optional(),
    count: z.number().int().positive().max(240).default(60),
    endDate: tradeDateSchema.optional(),
  })
  .strict();

export const proposeMemoryWriteToolPayloadSchema = memoryWriteRequestSchema;

export const proposeTradeIntentToolPayloadSchema = z
  .object({
    intentId: identifierSchema.optional(),
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80).optional(),
    side: z.enum(["BUY", "SELL", "HOLD", "WATCH"]),
    quantity: positiveQuantitySchema.optional(),
    limitPrice: positiveMoneySchema.optional(),
    currency: currencySchema.default("CNY"),
    rationale: z.string().trim().min(1).max(2000),
    reviewReason: z.string().trim().min(1).max(1000).optional(),
    evidenceRefs: z.array(z.string().trim().min(1).max(240)).default([]),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export const toolRuntimePlanStatusSchema = z.enum([
  "planned",
  "proposal_required",
  "rejected",
]);

export const toolRuntimePlanActionSchema = z.enum([
  "read_memory",
  "search_memory",
  "get_quote",
  "fetch_history",
  "memory_write_allowed",
  "memory_write_review_proposal",
  "trade_intent_review_proposal",
  "reject",
]);

export const toolRuntimePlanSchema = z
  .object({
    planId: identifierSchema,
    requestId: identifierSchema,
    toolType: z.string().trim().min(1).max(80),
    status: toolRuntimePlanStatusSchema,
    action: toolRuntimePlanActionSchema,
    canExecute: z.literal(false).default(false),
    executionAllowed: z.literal(false).default(false),
    brokerSubmissionAllowed: z.literal(false).default(false),
    accountWriteAllowed: z.literal(false).default(false),
    liveTradingAllowed: z.literal(false).default(false),
    payload: jsonValueSchema.default({}),
    proposal: reviewProposalSchema.optional(),
    rejectionReasons: z.array(z.string().trim().min(1).max(160)).default([]),
    auditEvent: auditEventSchema,
  })
  .strict();

export interface PlanToolRuntimeRequestOptions {
  now?: Date | string;
  planIdPrefix?: string;
  auditEventIdPrefix?: string;
  proposalIdPrefix?: string;
}

export type ToolRuntimeRequester = z.infer<typeof toolRuntimeRequesterSchema>;
export type ToolRuntimeRequest = z.infer<typeof toolRuntimeRequestSchema>;
export type ReadMemoryToolPayload = z.infer<typeof readMemoryToolPayloadSchema>;
export type SearchMemoryToolPayload = z.infer<typeof searchMemoryToolPayloadSchema>;
export type GetQuoteToolPayload = z.infer<typeof getQuoteToolPayloadSchema>;
export type FetchHistoryToolPayload = z.infer<typeof fetchHistoryToolPayloadSchema>;
export type ProposeMemoryWriteToolPayload = z.infer<typeof proposeMemoryWriteToolPayloadSchema>;
export type ProposeTradeIntentToolPayload = z.infer<typeof proposeTradeIntentToolPayloadSchema>;
export type ToolRuntimePlanStatus = z.infer<typeof toolRuntimePlanStatusSchema>;
export type ToolRuntimePlanAction = z.infer<typeof toolRuntimePlanActionSchema>;
export type ToolRuntimePlan = z.infer<typeof toolRuntimePlanSchema>;

export function planToolRuntimeRequest(
  requestInput: unknown,
  options: PlanToolRuntimeRequestOptions = {},
): ToolRuntimePlan {
  const request = parseToolRuntimeRequest(requestInput);
  const occurredAt = normalizeDate(options.now ?? request.requestedAt ?? new Date()).toISOString();

  if (isForbiddenToolType(request.toolType)) {
    return rejectedPlan(request, {
      occurredAt,
      options,
      rejectionReasons: ["forbidden_tool"],
      auditMetadata: {
        rejectionCategory: "forbidden_tool",
      },
    });
  }

  if (!isAllowedToolType(request.toolType)) {
    return rejectedPlan(request, {
      occurredAt,
      options,
      rejectionReasons: ["unsupported_tool"],
      auditMetadata: {
        rejectionCategory: "unsupported_tool",
      },
    });
  }

  switch (request.toolType) {
    case "read_memory":
      return planParsedPayload(request, readMemoryToolPayloadSchema, {
        occurredAt,
        options,
        action: "read_memory",
        payloadMetadata: (payload) => ({
          category: payload.category,
          relativePath: payload.relativePath,
        }),
      });
    case "search_memory":
      return planParsedPayload(request, searchMemoryToolPayloadSchema, {
        occurredAt,
        options,
        action: "search_memory",
        payloadMetadata: (payload) => ({
          queryLength: payload.query.length,
          categoryCount: payload.categories?.length ?? 0,
          limit: payload.limit ?? null,
        }),
      });
    case "get_quote":
      return planParsedPayload(request, getQuoteToolPayloadSchema, {
        occurredAt,
        options,
        action: "get_quote",
        payloadMetadata: (payload) => ({
          symbol: payload.symbol,
          market: payload.market ?? null,
        }),
      });
    case "fetch_history":
      return planParsedPayload(request, fetchHistoryToolPayloadSchema, {
        occurredAt,
        options,
        action: "fetch_history",
        payloadMetadata: (payload) => ({
          symbol: payload.symbol,
          market: payload.market ?? null,
          count: payload.count ?? null,
          endDate: payload.endDate ?? null,
        }),
      });
    case "propose_memory_write":
      return planMemoryWriteRequest(request, {
        occurredAt,
        options,
      });
    case "propose_trade_intent":
      return planTradeIntentRequest(request, {
        occurredAt,
        options,
      });
  }
}

function planParsedPayload<TPayload extends JsonValue>(
  request: ToolRuntimeRequest,
  schema: z.ZodType<TPayload>,
  input: {
    occurredAt: string;
    options: PlanToolRuntimeRequestOptions;
    action: Extract<
      ToolRuntimePlanAction,
      "read_memory" | "search_memory" | "get_quote" | "fetch_history"
    >;
    payloadMetadata: (payload: TPayload) => Record<string, JsonValue>;
  },
): ToolRuntimePlan {
  const payloadResult = schema.safeParse(request.payload);

  if (!payloadResult.success) {
    return rejectedPlan(request, {
      occurredAt: input.occurredAt,
      options: input.options,
      rejectionReasons: ["invalid_payload"],
      auditMetadata: zodErrorMetadata(payloadResult.error),
    });
  }

  return toolRuntimePlanSchema.parse({
    planId: buildPlanId(request, input.options),
    requestId: request.requestId,
    toolType: request.toolType,
    status: "planned",
    action: input.action,
    canExecute: false,
    executionAllowed: false,
    brokerSubmissionAllowed: false,
    accountWriteAllowed: false,
    liveTradingAllowed: false,
    payload: payloadResult.data,
    rejectionReasons: [],
    auditEvent: auditEventForRequest(request, {
      occurredAt: input.occurredAt,
      options: input.options,
      planStatus: "planned",
      planAction: input.action,
      result: "success",
      severity: "info",
      metadata: input.payloadMetadata(payloadResult.data),
    }),
  });
}

function planMemoryWriteRequest(
  request: ToolRuntimeRequest,
  input: {
    occurredAt: string;
    options: PlanToolRuntimeRequestOptions;
  },
): ToolRuntimePlan {
  const payloadResult = proposeMemoryWriteToolPayloadSchema.safeParse(request.payload);

  if (!payloadResult.success) {
    return rejectedPlan(request, {
      occurredAt: input.occurredAt,
      options: input.options,
      rejectionReasons: ["invalid_payload"],
      auditMetadata: zodErrorMetadata(payloadResult.error),
    });
  }

  const memoryWriteRequest = payloadResult.data;
  const decision = evaluateMemoryWritePolicy(memoryWriteRequest);

  if (decision.status === "reject") {
    return rejectedPlan(request, {
      occurredAt: input.occurredAt,
      options: input.options,
      rejectionReasons: decision.reasons,
      auditMetadata: memoryWriteAuditMetadata(memoryWriteRequest, decision),
    });
  }

  if (decision.status === "proposal_required") {
    const proposal = createMemoryWriteReviewProposal(memoryWriteRequest, decision, {
      now: input.occurredAt,
      proposalIdPrefix: input.options.proposalIdPrefix ?? "tool-memory-write-proposal",
      metadata: {
        toolRequestId: request.requestId,
        toolType: request.toolType,
        liveTrading: false,
        directExecutionAllowed: false,
      },
    });

    return proposalPlan(request, {
      occurredAt: input.occurredAt,
      options: input.options,
      action: "memory_write_review_proposal",
      proposal,
      payload: {
        request: memoryWriteRequest,
        decision,
      },
      auditMetadata: memoryWriteAuditMetadata(memoryWriteRequest, decision),
    });
  }

  return toolRuntimePlanSchema.parse({
    planId: buildPlanId(request, input.options),
    requestId: request.requestId,
    toolType: request.toolType,
    status: "planned",
    action: "memory_write_allowed",
    canExecute: false,
    executionAllowed: false,
    brokerSubmissionAllowed: false,
    accountWriteAllowed: false,
    liveTradingAllowed: false,
    payload: {
      request: memoryWriteRequest,
      decision,
    },
    rejectionReasons: [],
    auditEvent: auditEventForRequest(request, {
      occurredAt: input.occurredAt,
      options: input.options,
      planStatus: "planned",
      planAction: "memory_write_allowed",
      result: "success",
      severity: "info",
      metadata: memoryWriteAuditMetadata(memoryWriteRequest, decision),
    }),
  });
}

function planTradeIntentRequest(
  request: ToolRuntimeRequest,
  input: {
    occurredAt: string;
    options: PlanToolRuntimeRequestOptions;
  },
): ToolRuntimePlan {
  const payloadResult = proposeTradeIntentToolPayloadSchema.safeParse(request.payload);

  if (!payloadResult.success) {
    return rejectedPlan(request, {
      occurredAt: input.occurredAt,
      options: input.options,
      rejectionReasons: ["invalid_payload"],
      auditMetadata: zodErrorMetadata(payloadResult.error),
    });
  }

  const payload = payloadResult.data;
  const proposal = createTradeIntentReviewProposalFromToolRequest(request, payload, {
    occurredAt: input.occurredAt,
    proposalIdPrefix: input.options.proposalIdPrefix ?? "tool-trade-proposal",
  });

  return proposalPlan(request, {
    occurredAt: input.occurredAt,
    options: input.options,
    action: "trade_intent_review_proposal",
    proposal,
    payload,
    auditMetadata: tradeIntentAuditMetadata(payload, proposal),
  });
}

function createTradeIntentReviewProposalFromToolRequest(
  request: ToolRuntimeRequest,
  payload: ProposeTradeIntentToolPayload,
  input: {
    occurredAt: string;
    proposalIdPrefix: string;
  },
): TradeIntentReviewProposal {
  return tradeIntentReviewProposalSchema.parse({
    proposalId: buildTradeProposalId({
      prefix: input.proposalIdPrefix,
      requestId: request.requestId,
      symbol: payload.symbol,
      intentId: payload.intentId,
    }),
    proposalType: "trade_intent_review",
    status: "pending_review",
    source: {
      sourceType: "brain_tool_request",
      requestId: request.requestId,
      toolType: "propose_trade_intent",
    },
    symbol: payload.symbol,
    market: payload.market,
    name: payload.name,
    side: payload.side,
    quantity: payload.quantity,
    limitPrice: payload.limitPrice,
    currency: payload.currency,
    rationale: payload.rationale,
    reviewReason:
      payload.reviewReason ??
      `Brain tool request ${request.requestId} proposed a non-executable ${payload.side} trade intent that requires manual confirmation.`,
    executionGuard: {
      requiresManualReview: true,
      executable: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    },
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
    createdBy: {
      type: "system",
      id: "tool-runtime",
    },
    metadata: {
      ...payload.metadata,
      toolRequestId: request.requestId,
      toolType: request.toolType,
      evidenceRefs: payload.evidenceRefs,
      liveTrading: false,
      directExecutionAllowed: false,
    },
  });
}

function proposalPlan(
  request: ToolRuntimeRequest,
  input: {
    occurredAt: string;
    options: PlanToolRuntimeRequestOptions;
    action: Extract<
      ToolRuntimePlanAction,
      "memory_write_review_proposal" | "trade_intent_review_proposal"
    >;
    proposal: ReviewProposal;
    payload: JsonValue;
    auditMetadata: Record<string, JsonValue>;
  },
): ToolRuntimePlan {
  return toolRuntimePlanSchema.parse({
    planId: buildPlanId(request, input.options),
    requestId: request.requestId,
    toolType: request.toolType,
    status: "proposal_required",
    action: input.action,
    canExecute: false,
    executionAllowed: false,
    brokerSubmissionAllowed: false,
    accountWriteAllowed: false,
    liveTradingAllowed: false,
    payload: input.payload,
    proposal: input.proposal,
    rejectionReasons: [],
    auditEvent: auditEventForRequest(request, {
      occurredAt: input.occurredAt,
      options: input.options,
      planStatus: "proposal_required",
      planAction: input.action,
      result: "success",
      severity: "info",
      metadata: input.auditMetadata,
    }),
  });
}

function rejectedPlan(
  request: ToolRuntimeRequest,
  input: {
    occurredAt: string;
    options: PlanToolRuntimeRequestOptions;
    rejectionReasons: readonly string[];
    auditMetadata: Record<string, JsonValue>;
  },
): ToolRuntimePlan {
  return toolRuntimePlanSchema.parse({
    planId: buildPlanId(request, input.options),
    requestId: request.requestId,
    toolType: request.toolType,
    status: "rejected",
    action: "reject",
    canExecute: false,
    executionAllowed: false,
    brokerSubmissionAllowed: false,
    accountWriteAllowed: false,
    liveTradingAllowed: false,
    payload: {},
    rejectionReasons: [...input.rejectionReasons],
    auditEvent: auditEventForRequest(request, {
      occurredAt: input.occurredAt,
      options: input.options,
      planStatus: "rejected",
      planAction: "reject",
      result: "rejected",
      severity: "warning",
      metadata: {
        ...input.auditMetadata,
        rejectionReasons: [...input.rejectionReasons],
      },
    }),
  });
}

function auditEventForRequest(
  request: ToolRuntimeRequest,
  input: {
    occurredAt: string;
    options: PlanToolRuntimeRequestOptions;
    planStatus: ToolRuntimePlanStatus;
    planAction: ToolRuntimePlanAction;
    result: "success" | "rejected";
    severity: "info" | "warning";
    metadata: Record<string, JsonValue>;
  },
): AuditEvent {
  return auditEventSchema.parse({
    eventId: buildAuditEventId(request, input.options),
    occurredAt: input.occurredAt,
    actor: actorFromRequester(request.requestedBy),
    action: "validate",
    subject: {
      type: "brain",
      id: request.requestId,
    },
    severity: input.severity,
    result: input.result,
    message: `ToolRuntime ${input.planStatus} ${request.toolType} request ${request.requestId}`,
    correlationId: request.requestId,
    metadata: {
      toolType: request.toolType,
      requestedAt: request.requestedAt ?? null,
      planStatus: input.planStatus,
      planAction: input.planAction,
      canExecute: false,
      executionAllowed: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
      ...input.metadata,
    },
  });
}

function memoryWriteAuditMetadata(
  request: ProposeMemoryWriteToolPayload,
  decision: MemoryWritePolicyDecision,
): Record<string, JsonValue> {
  return {
    memoryRequestId: request.requestId,
    writeType: request.writeType,
    operation: request.operation,
    targetCategory: request.targetCategory,
    targetPath: request.targetPath,
    policyStatus: decision.status,
    policyReasons: decision.reasons,
    requiresProposal: decision.requiresProposal,
    autoApplyAllowed: decision.autoApplyAllowed,
  };
}

function tradeIntentAuditMetadata(
  payload: ProposeTradeIntentToolPayload,
  proposal: TradeIntentReviewProposal,
): Record<string, JsonValue> {
  return {
    proposalId: proposal.proposalId,
    proposalType: proposal.proposalType,
    symbol: payload.symbol,
    market: payload.market,
    side: payload.side,
    hasQuantity: payload.quantity !== undefined,
    hasLimitPrice: payload.limitPrice !== undefined,
    requiresManualReview: proposal.executionGuard.requiresManualReview,
    proposalExecutable: proposal.executionGuard.executable,
  };
}

function zodErrorMetadata(error: z.ZodError): Record<string, JsonValue> {
  const firstIssue = error.issues[0];

  return {
    rejectionCategory: "invalid_payload",
    validationIssueCount: error.issues.length,
    firstIssuePath: firstIssue ? firstIssue.path.join(".") : "",
    firstIssueCode: firstIssue?.code ?? "unknown",
  };
}

function parseToolRuntimeRequest(input: unknown): ToolRuntimeRequest {
  const result = toolRuntimeRequestSchema.safeParse(input);

  if (!result.success) {
    throw new ToolRuntimeValidationError("Invalid ToolRuntime request envelope", result.error);
  }

  return result.data;
}

function actorFromRequester(requester: ToolRuntimeRequester): {
  type: "brain" | "system" | "user";
  id?: string;
} {
  return requester.id
    ? {
        type: requester.type,
        id: requester.id,
      }
    : {
        type: requester.type,
      };
}

function isAllowedToolType(toolType: string): toolType is (typeof allowedToolRuntimeToolTypes)[number] {
  return (allowedToolRuntimeToolTypes as readonly string[]).includes(toolType);
}

function isForbiddenToolType(
  toolType: string,
): toolType is (typeof forbiddenToolRuntimeToolTypes)[number] {
  return (forbiddenToolRuntimeToolTypes as readonly string[]).includes(toolType);
}

function buildPlanId(
  request: ToolRuntimeRequest,
  options: PlanToolRuntimeRequestOptions,
): string {
  return [
    safeIdentifier(options.planIdPrefix ?? "tool-plan", 32),
    safeIdentifier(request.requestId, 80),
  ].join("-");
}

function buildAuditEventId(
  request: ToolRuntimeRequest,
  options: PlanToolRuntimeRequestOptions,
): string {
  return [
    safeIdentifier(options.auditEventIdPrefix ?? "audit-tool-runtime", 40),
    safeIdentifier(request.requestId, 80),
  ].join("-");
}

function buildTradeProposalId(input: {
  prefix: string;
  requestId: string;
  symbol: string;
  intentId?: string;
}): string {
  return [
    safeIdentifier(input.prefix, 32),
    safeIdentifier(input.requestId, 56),
    input.symbol,
    safeIdentifier(input.intentId ?? "intent", 32),
  ].join("-");
}

function safeIdentifier(value: string, maxLength: number): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, maxLength);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}

function normalizeDate(value: Date | string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ToolRuntimeValidationError("Invalid ToolRuntime date");
    }

    return value;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new ToolRuntimeValidationError(`Invalid ToolRuntime date: ${value}`);
  }

  return parsed;
}

export class ToolRuntimeValidationError extends Error {
  readonly issues?: z.ZodIssue[];

  constructor(message: string, error?: z.ZodError) {
    super(message);
    this.name = "ToolRuntimeValidationError";
    this.issues = error?.issues;
  }
}
