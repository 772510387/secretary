import {
  validateResearchReport,
  type ResearchReport,
} from "../research/index.js";
import {
  memoryWritePolicyDecisionSchema,
  memoryWriteRequestSchema,
  memoryWriteReviewProposalSchema,
  tradeIntentReviewProposalSchema,
  type MemoryWritePolicyDecision,
  type MemoryWriteRequest,
  type MemoryWriteReviewProposal,
  type TradeIntentReviewProposal,
} from "./schemas.js";

export interface CreateTradeIntentReviewProposalsOptions {
  now?: Date | string;
  proposalIdPrefix?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateMemoryWriteReviewProposalOptions {
  now?: Date | string;
  proposalIdPrefix?: string;
  metadata?: Record<string, unknown>;
}

export function createTradeIntentReviewProposalsFromResearchReport(
  reportInput: ResearchReport,
  options: CreateTradeIntentReviewProposalsOptions = {},
): TradeIntentReviewProposal[] {
  const report = validateResearchReport(reportInput);
  const createdAt = normalizeDate(options.now ?? report.generatedAt).toISOString();
  const proposalIdPrefix = options.proposalIdPrefix ?? "proposal";

  return report.tradeIntentDrafts.map((draft, index) =>
    tradeIntentReviewProposalSchema.parse({
      proposalId: buildProposalId({
        prefix: proposalIdPrefix,
        symbol: report.symbol,
        tradingDate: report.tradingDate,
        index,
        draftId: draft.draftId,
      }),
      proposalType: "trade_intent_review",
      status: "pending_review",
      source: {
        sourceType: "research_report",
        reportId: report.reportId,
        taskId: report.taskId,
        draftId: draft.draftId,
        provider: report.provider,
      },
      symbol: draft.symbol,
      market: draft.market,
      name: draft.name,
      side: draft.side,
      quantity: draft.quantity,
      limitPrice: draft.limitPrice,
      currency: draft.currency,
      rationale: draft.rationale,
      reviewReason: `Research report ${report.reportId} produced a non-executable ${draft.side} draft that requires manual confirmation.`,
      executionGuard: {
        requiresManualReview: true,
        executable: false,
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
      },
      createdAt,
      updatedAt: createdAt,
      createdBy: {
        type: "system",
        id: "research-proposal-converter",
      },
      metadata: {
        ...options.metadata,
        reportId: report.reportId,
        taskId: report.taskId,
        provider: report.provider,
        tradingDate: report.tradingDate,
        sourceDraftSide: draft.side,
        requiresHumanReview: report.requiresHumanReview,
        liveTrading: false,
        directExecutionAllowed: false,
      },
    }),
  );
}

export function createMemoryWriteReviewProposal(
  requestInput: MemoryWriteRequest,
  decisionInput: MemoryWritePolicyDecision,
  options: CreateMemoryWriteReviewProposalOptions = {},
): MemoryWriteReviewProposal {
  const request = memoryWriteRequestSchema.parse(requestInput);
  const decision = memoryWritePolicyDecisionSchema.parse(decisionInput);

  if (decision.status !== "proposal_required") {
    throw new MemoryProposalError("Memory write review proposal requires proposal_required decision");
  }

  const createdAt = normalizeDate(options.now ?? request.requestedAt).toISOString();
  const proposalIdPrefix = options.proposalIdPrefix ?? "memory-write-proposal";

  return memoryWriteReviewProposalSchema.parse({
    proposalId: buildMemoryWriteProposalId({
      prefix: proposalIdPrefix,
      requestId: request.requestId,
    }),
    proposalType: "memory_write_review",
    status: "pending_review",
    source: {
      sourceType: "memory_write_request",
      requestId: request.requestId,
      requestedBy: request.requestedBy,
      writeType: request.writeType,
    },
    request,
    decision,
    reviewReason: `Memory write request ${request.requestId} requires manual review before applying to ${request.targetCategory}.`,
    executionGuard: {
      requiresManualReview: true,
      executable: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    },
    createdAt,
    updatedAt: createdAt,
    createdBy: {
      type: "system",
      id: "memory-write-policy",
    },
    metadata: {
      ...options.metadata,
      requestId: request.requestId,
      writeType: request.writeType,
      targetCategory: request.targetCategory,
      requiresManualReview: true,
      autoApplyAllowed: false,
      liveTrading: false,
      directExecutionAllowed: false,
    },
  });
}

function buildProposalId(input: {
  prefix: string;
  symbol: string;
  tradingDate: string;
  index: number;
  draftId: string;
}): string {
  return [
    safeIdentifier(input.prefix, 24),
    input.symbol,
    input.tradingDate,
    String(input.index + 1).padStart(2, "0"),
    safeIdentifier(input.draftId, 56),
  ].join("-");
}

function buildMemoryWriteProposalId(input: {
  prefix: string;
  requestId: string;
}): string {
  return [safeIdentifier(input.prefix, 32), safeIdentifier(input.requestId, 80)].join("-");
}

function safeIdentifier(value: string, maxLength: number): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, maxLength);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}

function normalizeDate(value: Date | string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new MemoryProposalError("Invalid proposal date");
    }

    return value;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new MemoryProposalError(`Invalid proposal date: ${value}`);
  }

  return parsed;
}

export class MemoryProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryProposalError";
  }
}
