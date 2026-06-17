import {
  memoryWritePolicyDecisionSchema,
  memoryWriteRequestSchema,
  type MemoryWritePolicyDecision,
  type MemoryWritePolicyReason,
  type MemoryWriteRequest,
  type MemoryWriteTargetCategory,
  type MemoryWriteType,
} from "./schemas.js";

const POLICY_VERSION = "memory-write-policy-v1";

const AUTO_WRITE_TYPES = new Set<MemoryWriteType>([
  "daily_reflection",
  "experience_summary",
  "topic_logic",
  "error_pattern",
  "log_summary",
]);

const HARD_RULE_WRITE_TYPES = new Set<MemoryWriteType>([
  "main_board_rule_change",
  "t1_rule_change",
  "lot_size_rule_change",
  "stop_loss_rule_change",
  "position_limit_rule_change",
]);

const REJECT_WRITE_TYPES = new Set<MemoryWriteType>([
  "audit_deletion",
  "secret_write",
  "risk_bypass",
  "direct_order",
]);

const PROTECTED_TARGETS = new Set<MemoryWriteTargetCategory>([
  "rules",
  "config",
  "portfolio",
  "broker",
  "orders",
]);

export function evaluateMemoryWritePolicy(
  requestInput: MemoryWriteRequest,
): MemoryWritePolicyDecision {
  const request = memoryWriteRequestSchema.parse(requestInput);
  const reasons = new Set<MemoryWritePolicyReason>();

  collectRejectReasons(request, reasons);

  if (hasRejectReason(reasons)) {
    return createDecision(request, "reject", reasons);
  }

  if (request.writeType === "soft_threshold_adjustment") {
    collectSoftThresholdReasons(request, reasons);

    if (reasons.has("soft_threshold_out_of_bounds")) {
      return createDecision(request, "reject", reasons);
    }

    if (
      reasons.has("soft_threshold_within_bounds") &&
      !reasons.has("soft_threshold_missing_evidence") &&
      !reasons.has("soft_threshold_missing_bounds") &&
      !request.riskControls.weakensHardRule
    ) {
      return createDecision(request, "allow", reasons);
    }

    return createDecision(request, "proposal_required", reasons);
  }

  collectProposalReasons(request, reasons);

  if (requiresProposal(reasons)) {
    return createDecision(request, "proposal_required", reasons);
  }

  if (AUTO_WRITE_TYPES.has(request.writeType) && isAppendLikeOperation(request.operation)) {
    reasons.add("auto_memory_type");
    return createDecision(request, "allow", reasons);
  }

  reasons.add("dangerous_operation");
  return createDecision(request, "proposal_required", reasons);
}

export class MemoryWritePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryWritePolicyError";
  }
}

function collectRejectReasons(
  request: MemoryWriteRequest,
  reasons: Set<MemoryWritePolicyReason>,
): void {
  if (REJECT_WRITE_TYPES.has(request.writeType)) {
    if (request.writeType === "audit_deletion") {
      reasons.add("audit_deletion");
    }

    if (request.writeType === "secret_write") {
      reasons.add("secret_write");
    }

    if (request.writeType === "risk_bypass") {
      reasons.add("risk_bypass");
    }

    if (request.writeType === "direct_order") {
      reasons.add("direct_order");
    }
  }

  if (request.riskControls.containsSecret || request.targetCategory === "secrets") {
    reasons.add("secret_write");
  }

  if (
    request.riskControls.deletesAudit ||
    request.targetCategory === "audit" ||
    (request.targetCategory === "logs" && request.operation === "delete")
  ) {
    reasons.add("audit_deletion");
  }

  if (request.riskControls.bypassesRisk) {
    reasons.add("risk_bypass");
  }

  if (request.riskControls.touchesAccountOrOrder || request.targetCategory === "orders") {
    reasons.add("account_or_order_write");
  }

  if (request.riskControls.convertsModelOutputToOrder) {
    reasons.add("direct_order");
  }
}

function collectSoftThresholdReasons(
  request: MemoryWriteRequest,
  reasons: Set<MemoryWritePolicyReason>,
): void {
  const change = request.softThresholdChange;

  if (!change) {
    reasons.add("soft_threshold_missing_bounds");
    return;
  }

  if (request.evidenceRefs.length === 0) {
    reasons.add("soft_threshold_missing_evidence");
  }

  if (change.proposedValue < change.minValue || change.proposedValue > change.maxValue) {
    reasons.add("soft_threshold_out_of_bounds");
  } else {
    reasons.add("soft_threshold_within_bounds");
  }

  if (request.riskControls.weakensHardRule) {
    reasons.add("hard_rule_weakening");
  }
}

function collectProposalReasons(
  request: MemoryWriteRequest,
  reasons: Set<MemoryWritePolicyReason>,
): void {
  if (HARD_RULE_WRITE_TYPES.has(request.writeType)) {
    reasons.add("hard_rule_change");
  }

  if (request.riskControls.weakensHardRule) {
    reasons.add("hard_rule_weakening");
  }

  if (request.writeType === "live_trading_change" || request.riskControls.touchesLiveTrading) {
    reasons.add("live_trading_boundary");
  }

  if (request.writeType === "broker_boundary_change" || request.riskControls.touchesBrokerBoundary) {
    reasons.add("broker_boundary");
  }

  if (PROTECTED_TARGETS.has(request.targetCategory)) {
    reasons.add("protected_target");
  }

  if (!isAppendLikeOperation(request.operation)) {
    reasons.add("dangerous_operation");
  }
}

function hasRejectReason(reasons: Set<MemoryWritePolicyReason>): boolean {
  return (
    reasons.has("secret_write") ||
    reasons.has("audit_deletion") ||
    reasons.has("risk_bypass") ||
    reasons.has("account_or_order_write") ||
    reasons.has("direct_order")
  );
}

function requiresProposal(reasons: Set<MemoryWritePolicyReason>): boolean {
  return (
    reasons.has("hard_rule_change") ||
    reasons.has("hard_rule_weakening") ||
    reasons.has("protected_target") ||
    reasons.has("dangerous_operation") ||
    reasons.has("live_trading_boundary") ||
    reasons.has("broker_boundary")
  );
}

function isAppendLikeOperation(operation: MemoryWriteRequest["operation"]): boolean {
  return operation === "create" || operation === "append";
}

function createDecision(
  request: MemoryWriteRequest,
  status: MemoryWritePolicyDecision["status"],
  reasons: Set<MemoryWritePolicyReason>,
): MemoryWritePolicyDecision {
  const reasonList =
    reasons.size > 0 ? Array.from(reasons).sort() : (["auto_memory_type"] as MemoryWritePolicyReason[]);

  return memoryWritePolicyDecisionSchema.parse({
    status,
    reasons: reasonList,
    requiresAudit: true,
    requiresProposal: status === "proposal_required",
    autoApplyAllowed: status === "allow",
    targetCategory: request.targetCategory,
    targetPath: request.targetPath,
    metadata: {
      policyVersion: POLICY_VERSION,
      writeType: request.writeType,
      operation: request.operation,
    },
  });
}
