import {
  approvalRecordSchema,
  reviewProposalSchema,
  type ApprovalRecord,
  type ReviewProposal,
} from "./schemas.js";

export interface CreateApprovalRecordInput extends ApprovalRecord {}

export function createApprovalRecord(input: CreateApprovalRecordInput): ApprovalRecord {
  return approvalRecordSchema.parse(input);
}

export function applyApprovalToProposal(
  proposalInput: ReviewProposal,
  approvalInput: ApprovalRecord,
): ReviewProposal {
  const proposal = reviewProposalSchema.parse(proposalInput);
  const approval = approvalRecordSchema.parse(approvalInput);

  if (proposal.proposalId !== approval.proposalId) {
    throw new ApprovalRecordError("Approval proposalId does not match proposal");
  }

  if (proposal.status !== "pending_review") {
    throw new ApprovalRecordError(`Proposal ${proposal.proposalId} is not pending_review`);
  }

  if (Date.parse(approval.reviewedAt) < Date.parse(proposal.createdAt)) {
    throw new ApprovalRecordError("Approval reviewedAt must be greater than or equal to proposal createdAt");
  }

  return reviewProposalSchema.parse({
    ...proposal,
    status: approval.decision,
    reviewedAt: approval.reviewedAt,
    reviewedBy: approval.reviewer,
    reviewNote: approval.reviewNote,
    updatedAt: approval.reviewedAt,
    metadata: {
      ...asRecord(proposal.metadata),
      approvalId: approval.approvalId,
      operatorSessionId: approval.operatorSessionId,
      riskSnapshotRef: approval.riskSnapshotRef,
      approvalDecision: approval.decision,
      brokerSubmissionAllowed: false,
      directBrokerHandoff: false,
      liveTradingAllowed: false,
    },
  });
}

export class ApprovalRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRecordError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
