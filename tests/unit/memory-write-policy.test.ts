import { describe, expect, it } from "vitest";
import {
  createMemoryWriteReviewProposal,
  evaluateMemoryWritePolicy,
  memoryWriteRequestSchema,
  type MemoryWriteRequest,
} from "../../src/domain/memory/index.js";

const requestedAt = "2026-06-14T00:00:00.000Z";

type MemoryWriteRequestOverrides = Omit<Partial<MemoryWriteRequest>, "riskControls"> & {
  riskControls?: Partial<MemoryWriteRequest["riskControls"]>;
};

describe("MemoryWritePolicy", () => {
  it("allows ordinary reflection and experience writes to append-only memory", () => {
    const decision = evaluateMemoryWritePolicy(
      makeRequest({
        writeType: "daily_reflection",
        operation: "append",
        targetCategory: "daily_logs",
        targetPath: "memory/daily_logs/2026-06/2026-06-14.md",
      }),
    );

    expect(decision).toMatchObject({
      status: "allow",
      reasons: ["auto_memory_type"],
      requiresAudit: true,
      requiresProposal: false,
      autoApplyAllowed: true,
      targetCategory: "daily_logs",
    });
  });

  it("allows soft threshold adjustments only when bounds and evidence are present", () => {
    const decision = evaluateMemoryWritePolicy(
      makeRequest({
        writeType: "soft_threshold_adjustment",
        operation: "update",
        targetCategory: "long_term",
        targetPath: "memory/long_term/2026-06/threshold-adjustments.md",
        evidenceRefs: [
          "memory/reports/2026-06-14/daily_reflection.json",
          "memory/research/2026-06-14/research-000636.json",
        ],
        softThresholdChange: {
          key: "topic_heat_watch_threshold",
          currentValue: 0.6,
          proposedValue: 0.65,
          minValue: 0.5,
          maxValue: 0.8,
        },
      }),
    );

    expect(decision).toMatchObject({
      status: "allow",
      reasons: ["soft_threshold_within_bounds"],
      requiresProposal: false,
      autoApplyAllowed: true,
    });
  });

  it("requires a proposal when a soft threshold lacks evidence", () => {
    const decision = evaluateMemoryWritePolicy(
      makeRequest({
        writeType: "soft_threshold_adjustment",
        operation: "update",
        targetCategory: "long_term",
        targetPath: "memory/long_term/2026-06/threshold-adjustments.md",
        evidenceRefs: [],
        softThresholdChange: {
          key: "topic_heat_watch_threshold",
          currentValue: 0.6,
          proposedValue: 0.65,
          minValue: 0.5,
          maxValue: 0.8,
        },
      }),
    );

    expect(decision.status).toBe("proposal_required");
    expect(decision.reasons).toContain("soft_threshold_missing_evidence");
    expect(decision.requiresProposal).toBe(true);
  });

  it("rejects soft threshold adjustments outside configured bounds", () => {
    const decision = evaluateMemoryWritePolicy(
      makeRequest({
        writeType: "soft_threshold_adjustment",
        operation: "update",
        targetCategory: "long_term",
        targetPath: "memory/long_term/2026-06/threshold-adjustments.md",
        evidenceRefs: ["memory/reports/2026-06-14/daily_reflection.json"],
        softThresholdChange: {
          key: "topic_heat_watch_threshold",
          currentValue: 0.6,
          proposedValue: 0.9,
          minValue: 0.5,
          maxValue: 0.8,
        },
      }),
    );

    expect(decision.status).toBe("reject");
    expect(decision.reasons).toContain("soft_threshold_out_of_bounds");
  });

  it("routes hard rule changes and hard-rule weakening into manual proposals", () => {
    const decision = evaluateMemoryWritePolicy(
      makeRequest({
        writeType: "stop_loss_rule_change",
        operation: "update",
        targetCategory: "rules",
        targetPath: "memory/rules/risk.md",
        riskControls: {
          weakensHardRule: true,
        },
      }),
    );

    expect(decision.status).toBe("proposal_required");
    expect(decision.reasons).toContain("hard_rule_change");
    expect(decision.reasons).toContain("hard_rule_weakening");
    expect(decision.reasons).toContain("protected_target");
    expect(decision.requiresProposal).toBe(true);
    expect(decision.autoApplyAllowed).toBe(false);
  });

  it("routes live trading and broker boundary changes into manual proposals", () => {
    const liveDecision = evaluateMemoryWritePolicy(
      makeRequest({
        writeType: "live_trading_change",
        operation: "update",
        targetCategory: "config",
        targetPath: "config/default.example.json",
        riskControls: {
          touchesLiveTrading: true,
        },
      }),
    );
    const brokerDecision = evaluateMemoryWritePolicy(
      makeRequest({
        writeType: "broker_boundary_change",
        operation: "update",
        targetCategory: "broker",
        targetPath: "src/infrastructure/broker/README.md",
        riskControls: {
          touchesBrokerBoundary: true,
        },
      }),
    );

    expect(liveDecision.status).toBe("proposal_required");
    expect(liveDecision.reasons).toContain("live_trading_boundary");
    expect(brokerDecision.status).toBe("proposal_required");
    expect(brokerDecision.reasons).toContain("broker_boundary");
  });

  it("rejects secrets, audit deletion, risk bypass, account writes, and direct orders", () => {
    const rejected = [
      makeRequest({
        writeType: "secret_write",
        targetCategory: "secrets",
        riskControls: { containsSecret: true },
      }),
      makeRequest({
        writeType: "audit_deletion",
        operation: "delete",
        targetCategory: "audit",
        riskControls: { deletesAudit: true },
      }),
      makeRequest({
        writeType: "risk_bypass",
        riskControls: { bypassesRisk: true },
      }),
      makeRequest({
        writeType: "experience_summary",
        targetCategory: "orders",
        riskControls: { touchesAccountOrOrder: true },
      }),
      makeRequest({
        writeType: "direct_order",
        targetCategory: "orders",
        riskControls: { convertsModelOutputToOrder: true },
      }),
    ].map((request) => evaluateMemoryWritePolicy(request));

    expect(rejected.map((decision) => decision.status)).toEqual([
      "reject",
      "reject",
      "reject",
      "reject",
      "reject",
    ]);
  });

  it("creates a memory write review proposal only for proposal_required decisions", () => {
    const request = makeRequest({
      writeType: "t1_rule_change",
      operation: "update",
      targetCategory: "rules",
      targetPath: "memory/rules/trading.md",
    });
    const decision = evaluateMemoryWritePolicy(request);
    const proposal = createMemoryWriteReviewProposal(request, decision, {
      now: requestedAt,
    });

    expect(proposal).toMatchObject({
      proposalId: "memory-write-proposal-memory-write-req-001",
      proposalType: "memory_write_review",
      status: "pending_review",
      source: {
        sourceType: "memory_write_request",
        requestId: "memory-write-req-001",
        writeType: "t1_rule_change",
      },
      request: {
        requestId: "memory-write-req-001",
        targetCategory: "rules",
      },
      decision: {
        status: "proposal_required",
      },
      executionGuard: {
        requiresManualReview: true,
        executable: false,
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
      },
      createdAt: requestedAt,
      updatedAt: requestedAt,
    });

    const allowed = evaluateMemoryWritePolicy(
      makeRequest({
        writeType: "experience_summary",
        operation: "append",
        targetCategory: "long_term",
        targetPath: "memory/long_term/2026-06/week3.md",
      }),
    );

    expect(() => createMemoryWriteReviewProposal(request, allowed)).toThrow();
  });
});

function makeRequest(overrides: MemoryWriteRequestOverrides = {}): MemoryWriteRequest {
  return memoryWriteRequestSchema.parse({
    requestId: "memory-write-req-001",
    requestedAt,
    requestedBy: {
      sourceType: "brain",
      sourceId: "mock-brain",
    },
    writeType: "experience_summary",
    operation: "append",
    targetCategory: "long_term",
    targetPath: "memory/long_term/2026-06/week3.md",
    title: "经验总结",
    contentSummary: "只保存摘要，完整正文由后续 storage 写入流程处理。",
    evidenceRefs: ["memory/reports/2026-06-14/daily_reflection.json"],
    metadata: {},
    ...overrides,
    riskControls: {
      weakensHardRule: false,
      touchesLiveTrading: false,
      touchesBrokerBoundary: false,
      touchesAccountOrOrder: false,
      containsSecret: false,
      deletesAudit: false,
      bypassesRisk: false,
      convertsModelOutputToOrder: false,
      ...overrides.riskControls,
    },
  });
}
