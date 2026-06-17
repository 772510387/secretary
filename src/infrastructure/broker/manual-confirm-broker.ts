import { z } from "zod";
import {
  auditEventSchema,
  type AuditEvent,
} from "../../domain/audit/index.js";
import {
  tradeIntentReviewProposalSchema,
  proposalActorSchema,
  type ProposalActor,
  type TradeIntentReviewProposal,
} from "../../domain/memory/index.js";
import {
  PolicyEngine,
  RiskEngine,
  type DailyLossState,
  type PolicyCheckResult,
  type PolicyEngineOptions,
  type RiskCheckResult,
  type RiskEngineOptions,
  type RiskRuntimeState,
} from "../../domain/risk/index.js";
import {
  createOrderFromIntent,
  tradeIntentSchema,
  type TradeIntent,
} from "../../domain/trading/index.js";
import { appendAuditEvent } from "../logging/index.js";
import { AtomicFileWriter } from "../storage/atomic-file-writer.js";
import { createPortfolioMemoryPaths } from "../storage/index.js";
import {
  PaperBroker,
  type SubmitPaperOrderResult,
} from "./paper-broker.js";

const manualApprovalSchema = z
  .object({
    approvalId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
    proposalId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
    decision: z.literal("approved"),
    approvedAt: z.string().datetime(),
    approvedBy: proposalActorSchema,
    reviewNote: z.string().trim().min(1).max(1000).optional(),
    expiresAt: z.string().datetime().optional(),
    revokedAt: z.string().datetime().optional(),
  })
  .strict();

export type ManualTradeApproval = z.infer<typeof manualApprovalSchema>;

export type ManualConfirmDelegateKind = "paper";

export type ManualConfirmRejectionCode =
  | "delegate_not_paper"
  | "invalid_approval"
  | "proposal_not_approved"
  | "proposal_rejected"
  | "proposal_already_applied"
  | "proposal_expired"
  | "proposal_revoked"
  | "approval_mismatch"
  | "approval_expired"
  | "approval_revoked"
  | "unsupported_proposal_side"
  | "missing_order_fields"
  | "policy_rejected"
  | "risk_rejected"
  | "delegate_rejected";

export interface ManualConfirmBrokerOptions {
  memoryDir: string;
  delegate: PaperBroker;
  delegateKind?: ManualConfirmDelegateKind;
  now?: () => Date;
  idGenerator?: () => string;
  writer?: AtomicFileWriter;
  policyEngine?: Pick<PolicyEngine, "checkOrder">;
  riskEngine?: Pick<RiskEngine, "check">;
  policyOptions?: PolicyEngineOptions;
  riskOptions?: RiskEngineOptions;
}

export interface SubmitApprovedTradeProposalInput {
  proposal: TradeIntentReviewProposal;
  approval?: ManualTradeApproval;
  accountId: string;
  intentId?: string;
  dailyLoss?: DailyLossState;
  runtimeState?: RiskRuntimeState;
  policyOptions?: PolicyEngineOptions;
  riskOptions?: RiskEngineOptions;
}

export interface ManualConfirmBrokerResult {
  accepted: boolean;
  delegated: boolean;
  rejectionCode?: ManualConfirmRejectionCode;
  rejectionMessage?: string;
  proposal: TradeIntentReviewProposal;
  approval?: ManualTradeApproval;
  intent?: TradeIntent;
  policyResult?: PolicyCheckResult;
  riskResult?: RiskCheckResult;
  delegateBroker: ManualConfirmDelegateKind;
  delegateResult?: SubmitPaperOrderResult;
  auditLogPath: string;
  auditBackupPath?: string;
}

export class ManualConfirmBroker {
  private readonly memoryDir: string;
  private readonly delegate: PaperBroker;
  private readonly delegateKind: ManualConfirmDelegateKind;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly writer: AtomicFileWriter;
  private readonly policyEngine: Pick<PolicyEngine, "checkOrder">;
  private readonly riskEngine: Pick<RiskEngine, "check">;
  private readonly policyOptions: PolicyEngineOptions;
  private readonly riskOptions: RiskEngineOptions;

  constructor(options: ManualConfirmBrokerOptions) {
    this.delegateKind = options.delegateKind ?? "paper";

    if (this.delegateKind !== "paper") {
      throw new ManualConfirmBrokerError("ManualConfirmBroker only supports paper delegate in this phase");
    }

    if (!(options.delegate instanceof PaperBroker)) {
      throw new ManualConfirmBrokerError("ManualConfirmBroker delegate must be a PaperBroker instance");
    }

    this.memoryDir = options.memoryDir;
    this.delegate = options.delegate;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.writer = options.writer ?? new AtomicFileWriter();
    this.policyEngine = options.policyEngine ?? new PolicyEngine();
    this.riskEngine = options.riskEngine ?? new RiskEngine();
    this.policyOptions = options.policyOptions ?? {};
    this.riskOptions = options.riskOptions ?? {};
  }

  submitApprovedProposal(input: SubmitApprovedTradeProposalInput): ManualConfirmBrokerResult {
    const now = this.validNow();
    const occurredAt = now.toISOString();
    const proposal = tradeIntentReviewProposalSchema.parse(input.proposal);
    const approvalParse = input.approval
      ? manualApprovalSchema.safeParse(input.approval)
      : undefined;
    const approval = approvalParse?.success ? approvalParse.data : undefined;
    const precheck = this.precheckProposal(proposal, approval, now);

    if (precheck) {
      return this.reject({
        proposal,
        approval,
        occurredAt,
        code: precheck.code,
        message: precheck.message,
        policyResult: undefined,
        riskResult: undefined,
      });
    }

    const orderFieldsCheck = validateOrderFields(proposal);

    if (orderFieldsCheck) {
      return this.reject({
        proposal,
        approval,
        occurredAt,
        code: orderFieldsCheck.code,
        message: orderFieldsCheck.message,
        policyResult: undefined,
        riskResult: undefined,
      });
    }

    const intent = tradeIntentSchema.parse({
      intentId: input.intentId ?? buildIntentId(proposal, approval!),
      accountId: input.accountId,
      symbol: proposal.symbol,
      market: proposal.market,
      name: proposal.name,
      side: proposal.side,
      quantity: proposal.quantity,
      limitPrice: proposal.limitPrice,
      currency: proposal.currency,
      source: "user",
      reason: `Manual approval ${approval!.approvalId} for proposal ${proposal.proposalId}`,
      createdAt: occurredAt,
    });
    const preflightOrder = createOrderFromIntent({
      orderId: `manual-preflight-${safeIdentifier(this.idGenerator(), 80)}`,
      intent,
      now,
    });
    const account = this.delegate.getAccount();
    const positions = this.delegate.getPositions();
    const policyResult = this.policyEngine.checkOrder({
      order: preflightOrder,
      account,
      positions,
      options: {
        ...this.policyOptions,
        ...input.policyOptions,
      },
    });

    if (policyResult.decision === "rejected") {
      return this.reject({
        proposal,
        approval: approval!,
        occurredAt,
        intent,
        policyResult,
        riskResult: undefined,
        code: "policy_rejected",
        message: policyResult.reason?.message ?? "PolicyEngine rejected manual-confirm handoff",
      });
    }

    const riskResult = this.riskEngine.check({
      account,
      positions,
      order: preflightOrder,
      dailyLoss: input.dailyLoss,
      runtimeState: input.runtimeState,
      options: {
        ...this.riskOptions,
        ...input.riskOptions,
      },
    });

    if (riskResult.decision === "rejected") {
      return this.reject({
        proposal,
        approval: approval!,
        occurredAt,
        intent,
        policyResult,
        riskResult,
        code: "risk_rejected",
        message: riskResult.blockingViolations[0]?.message
          ?? "RiskEngine rejected manual-confirm handoff",
      });
    }

    const delegateResult = this.delegate.submitOrder(intent);
    const accepted = delegateResult.order.status !== "rejected";
    const code = accepted ? undefined : "delegate_rejected";
    const message = accepted
      ? `ManualConfirmBroker delegated proposal ${proposal.proposalId} to paper broker`
      : delegateResult.order.rejectReason?.message ?? "Paper broker rejected delegated order";
    const auditWrite = this.writeAudit({
      occurredAt,
      proposal,
      approval: approval!,
      intent,
      policyResult,
      riskResult,
      delegateResult,
      result: accepted ? "success" : "rejected",
      severity: accepted ? "info" : "warning",
      code,
      message,
    });

    return {
      accepted,
      delegated: true,
      rejectionCode: code,
      rejectionMessage: accepted ? undefined : message,
      proposal,
      approval: approval!,
      intent,
      policyResult,
      riskResult,
      delegateBroker: this.delegateKind,
      delegateResult,
      auditLogPath: auditWrite.filePath,
      auditBackupPath: auditWrite.backupPath,
    };
  }

  private precheckProposal(
    proposal: TradeIntentReviewProposal,
    approval: ManualTradeApproval | undefined,
    now: Date,
  ): { code: ManualConfirmRejectionCode; message: string } | undefined {
    if (!approval) {
      return {
        code: "invalid_approval",
        message: "Manual approval record is required before broker handoff",
      };
    }

    if (approval.proposalId !== proposal.proposalId) {
      return {
        code: "approval_mismatch",
        message: `Approval ${approval.approvalId} does not match proposal ${proposal.proposalId}`,
      };
    }

    if (proposal.status === "pending_review") {
      return {
        code: "proposal_not_approved",
        message: `Proposal ${proposal.proposalId} is still pending review`,
      };
    }

    if (proposal.status === "rejected") {
      return {
        code: "proposal_rejected",
        message: `Proposal ${proposal.proposalId} was rejected`,
      };
    }

    if (proposal.status === "applied") {
      return {
        code: "proposal_already_applied",
        message: `Proposal ${proposal.proposalId} was already applied`,
      };
    }

    const proposalRevokedAt = metadataString(proposal.metadata, "revokedAt");

    if (proposalRevokedAt) {
      return {
        code: "proposal_revoked",
        message: `Proposal ${proposal.proposalId} was revoked at ${proposalRevokedAt}`,
      };
    }

    const proposalExpiresAt = metadataString(proposal.metadata, "expiresAt");

    if (proposalExpiresAt && Date.parse(proposalExpiresAt) <= now.getTime()) {
      return {
        code: "proposal_expired",
        message: `Proposal ${proposal.proposalId} expired at ${proposalExpiresAt}`,
      };
    }

    if (approval.revokedAt) {
      return {
        code: "approval_revoked",
        message: `Approval ${approval.approvalId} was revoked at ${approval.revokedAt}`,
      };
    }

    if (approval.expiresAt && Date.parse(approval.expiresAt) <= now.getTime()) {
      return {
        code: "approval_expired",
        message: `Approval ${approval.approvalId} expired at ${approval.expiresAt}`,
      };
    }

    return undefined;
  }

  private reject(input: {
    proposal: TradeIntentReviewProposal;
    approval?: ManualTradeApproval;
    occurredAt: string;
    intent?: TradeIntent;
    policyResult?: PolicyCheckResult;
    riskResult?: RiskCheckResult;
    code: ManualConfirmRejectionCode;
    message: string;
  }): ManualConfirmBrokerResult {
    const auditWrite = this.writeAudit({
      occurredAt: input.occurredAt,
      proposal: input.proposal,
      approval: input.approval,
      intent: input.intent,
      policyResult: input.policyResult,
      riskResult: input.riskResult,
      result: "rejected",
      severity: "warning",
      code: input.code,
      message: input.message,
    });

    return {
      accepted: false,
      delegated: false,
      rejectionCode: input.code,
      rejectionMessage: input.message,
      proposal: input.proposal,
      approval: input.approval,
      intent: input.intent,
      policyResult: input.policyResult,
      riskResult: input.riskResult,
      delegateBroker: this.delegateKind,
      auditLogPath: auditWrite.filePath,
      auditBackupPath: auditWrite.backupPath,
    };
  }

  private writeAudit(input: {
    occurredAt: string;
    proposal: TradeIntentReviewProposal;
    approval?: ManualTradeApproval;
    intent?: TradeIntent;
    policyResult?: PolicyCheckResult;
    riskResult?: RiskCheckResult;
    delegateResult?: SubmitPaperOrderResult;
    result: "success" | "rejected";
    severity: "info" | "warning";
    code?: ManualConfirmRejectionCode;
    message: string;
  }) {
    const paths = createPortfolioMemoryPaths(this.memoryDir, input.occurredAt);
    const event = auditEventForManualConfirm({
      ...input,
      eventId: `audit-manual-confirm-${safeIdentifier(this.idGenerator(), 80)}`,
      delegateBroker: this.delegateKind,
    });

    return appendAuditEvent(paths.auditLogPath, event, this.writer);
  }

  private validNow(): Date {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new ManualConfirmBrokerError("ManualConfirmBroker now() returned an invalid Date");
    }

    return value;
  }
}

function auditEventForManualConfirm(input: {
  eventId: string;
  occurredAt: string;
  proposal: TradeIntentReviewProposal;
  approval?: ManualTradeApproval;
  intent?: TradeIntent;
  policyResult?: PolicyCheckResult;
  riskResult?: RiskCheckResult;
  delegateResult?: SubmitPaperOrderResult;
  delegateBroker: ManualConfirmDelegateKind;
  result: "success" | "rejected";
  severity: "info" | "warning";
  code?: ManualConfirmRejectionCode;
  message: string;
}): AuditEvent {
  return auditEventSchema.parse({
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    actor: {
      type: "broker",
      id: "manual-confirm-broker",
    },
    action: "order",
    subject: {
      type: input.intent ? "order" : "memory",
      id: input.intent?.intentId ?? input.proposal.proposalId,
    },
    severity: input.severity,
    result: input.result,
    message: input.message,
    correlationId: input.proposal.proposalId,
    causationId: input.approval?.approvalId,
    metadata: {
      proposalId: input.proposal.proposalId,
      proposalStatus: input.proposal.status,
      approvalId: input.approval?.approvalId ?? null,
      approvalDecision: input.approval?.decision ?? null,
      approvedAt: input.approval?.approvedAt ?? null,
      approvedBy: actorMetadata(input.approval?.approvedBy),
      reviewedAt: input.proposal.reviewedAt ?? null,
      reviewedBy: actorMetadata(input.proposal.reviewedBy),
      delegateBroker: input.delegateBroker,
      delegated: input.delegateResult !== undefined,
      intentId: input.intent?.intentId ?? null,
      accountId: input.intent?.accountId ?? null,
      symbol: input.proposal.symbol,
      market: input.proposal.market,
      side: input.proposal.side,
      quantity: input.proposal.quantity ?? null,
      limitPrice: input.proposal.limitPrice ?? null,
      rejectionCode: input.code ?? null,
      policyResult: summarizePolicyResult(input.policyResult),
      riskResult: summarizeRiskResult(input.riskResult),
      delegateResult: summarizeDelegateResult(input.delegateResult),
      liveTrading: false,
      brokerSubmissionAllowed: input.result === "success",
    },
  });
}

function validateOrderFields(
  proposal: TradeIntentReviewProposal,
): { code: ManualConfirmRejectionCode; message: string } | undefined {
  if (proposal.side !== "BUY" && proposal.side !== "SELL") {
    return {
      code: "unsupported_proposal_side",
      message: `Proposal ${proposal.proposalId} side ${proposal.side} is not an executable order side`,
    };
  }

  if (proposal.quantity === undefined || proposal.limitPrice === undefined) {
    return {
      code: "missing_order_fields",
      message: `Proposal ${proposal.proposalId} requires quantity and limitPrice before broker handoff`,
    };
  }

  return undefined;
}

function summarizePolicyResult(result: PolicyCheckResult | undefined): Record<string, unknown> | null {
  if (!result) {
    return null;
  }

  return {
    decision: result.decision,
    reasonCode: result.reason?.code ?? null,
    reasonMessage: result.reason?.message ?? null,
  };
}

function summarizeRiskResult(result: RiskCheckResult | undefined): Record<string, unknown> | null {
  if (!result) {
    return null;
  }

  return {
    decision: result.decision,
    severity: result.severity,
    violationCodes: result.violations.map((violation) => violation.code),
    blockingViolationCodes: result.blockingViolations.map((violation) => violation.code),
    requiresManualConfirmation: result.requiresManualConfirmation,
  };
}

function summarizeDelegateResult(result: SubmitPaperOrderResult | undefined): Record<string, unknown> | null {
  if (!result) {
    return null;
  }

  return {
    broker: "paper",
    idempotent: result.idempotent,
    orderId: result.order.orderId,
    orderStatus: result.order.status,
    rejectCode: result.order.rejectReason?.code ?? null,
    tradeId: result.trade?.tradeId ?? null,
  };
}

function actorMetadata(actor: ProposalActor | undefined): Record<string, unknown> | null {
  if (!actor) {
    return null;
  }

  return {
    type: actor.type,
    id: actor.id ?? null,
  };
}

function metadataString(metadata: TradeIntentReviewProposal["metadata"], key: string): string | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }

  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildIntentId(
  proposal: TradeIntentReviewProposal,
  approval: ManualTradeApproval,
): string {
  return `intent-${safeIdentifier(proposal.proposalId, 52)}-${safeIdentifier(approval.approvalId, 52)}`;
}

function safeIdentifier(value: string, maxLength: number): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, maxLength);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}

export class ManualConfirmBrokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualConfirmBrokerError";
  }
}
