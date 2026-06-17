import { readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildInitialPaperAccountSeed } from "../../src/app/index.js";
import { auditEventSchema } from "../../src/domain/audit/index.js";
import {
  tradeIntentReviewProposalSchema,
  type TradeIntentReviewProposal,
} from "../../src/domain/memory/index.js";
import {
  ManualConfirmBroker,
  ManualConfirmBrokerError,
  PaperBroker,
  type ManualTradeApproval,
} from "../../src/infrastructure/broker/index.js";
import {
  createPortfolioMemoryPaths,
  initializePaperAccountMemory,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];
const baseNow = new Date("2026-06-15T01:30:00.000Z");
const baseNowIso = baseNow.toISOString();

describe("ManualConfirmBroker", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("delegates only an approved proposal to PaperBroker after PolicyEngine and RiskEngine pass", () => {
    const memoryDir = createInitializedMemory();
    const paperBroker = createPaperBroker(memoryDir);
    const broker = createManualBroker(memoryDir, paperBroker);
    const proposal = makeProposal({ status: "approved" });
    const approval = makeApproval(proposal);

    const result = broker.submitApprovedProposal({
      proposal,
      approval,
      accountId: "paper-main",
    });

    expect(result).toMatchObject({
      accepted: true,
      delegated: true,
      delegateBroker: "paper",
      policyResult: {
        decision: "passed",
      },
      riskResult: {
        decision: "passed",
      },
    });
    expect(result.intent).toMatchObject({
      intentId: `intent-${proposal.proposalId}-${approval.approvalId}`,
      source: "user",
      accountId: "paper-main",
      side: "BUY",
    });
    expect(result.delegateResult?.order.status).toBe("filled");
    expect(paperBroker.getAccount().cash.available).toBe(19000);
    expect(paperBroker.getTrades()).toHaveLength(1);

    const manualAudit = lastManualAudit(memoryDir);
    expect(manualAudit).toMatchObject({
      actor: {
        type: "broker",
        id: "manual-confirm-broker",
      },
      action: "order",
      result: "success",
      correlationId: proposal.proposalId,
      causationId: approval.approvalId,
      metadata: {
        proposalId: proposal.proposalId,
        approvalId: approval.approvalId,
        delegateBroker: "paper",
        delegated: true,
        policyResult: {
          decision: "passed",
        },
        riskResult: {
          decision: "passed",
          blockingViolationCodes: [],
        },
        delegateResult: {
          broker: "paper",
          orderStatus: "filled",
        },
        liveTrading: false,
      },
    });
    expect(JSON.stringify(manualAudit)).not.toContain(proposal.rationale);
    expect(JSON.stringify(manualAudit)).not.toContain(proposal.reviewReason);
  });

  it("blocks unconfirmed, rejected, and already-applied proposals before PaperBroker", () => {
    const cases: Array<{
      name: string;
      proposal: TradeIntentReviewProposal;
      approval?: ManualTradeApproval;
      expectedCode: string;
    }> = [
      {
        name: "missing approval",
        proposal: makeProposal({ status: "approved" }),
        approval: undefined,
        expectedCode: "invalid_approval",
      },
      {
        name: "pending proposal",
        proposal: makeProposal({ status: "pending_review" }),
        approval: makeApproval(makeProposal({ status: "pending_review" })),
        expectedCode: "proposal_not_approved",
      },
      {
        name: "rejected proposal",
        proposal: makeProposal({ status: "rejected" }),
        approval: makeApproval(makeProposal({ status: "rejected" })),
        expectedCode: "proposal_rejected",
      },
      {
        name: "applied proposal",
        proposal: makeProposal({ status: "applied" }),
        approval: makeApproval(makeProposal({ status: "applied" })),
        expectedCode: "proposal_already_applied",
      },
    ];

    for (const testCase of cases) {
      const memoryDir = createInitializedMemory(`manual-confirm-${testCase.name.replace(/\s+/g, "-")}-`);
      const paperBroker = createPaperBroker(memoryDir);
      const broker = createManualBroker(memoryDir, paperBroker);

      const result = broker.submitApprovedProposal({
        proposal: testCase.proposal,
        approval: testCase.approval,
        accountId: "paper-main",
      });

      expect(result.accepted).toBe(false);
      expect(result.delegated).toBe(false);
      expect(result.rejectionCode).toBe(testCase.expectedCode);
      expect(paperBroker.getOrders()).toHaveLength(0);
      expect(paperBroker.getTrades()).toHaveLength(0);
      expect(lastManualAudit(memoryDir)).toMatchObject({
        result: "rejected",
        metadata: {
          proposalId: testCase.proposal.proposalId,
          rejectionCode: testCase.expectedCode,
          delegated: false,
          delegateBroker: "paper",
        },
      });
    }
  });

  it("blocks expired and revoked proposals before PaperBroker", () => {
    const cases: Array<{
      proposal: TradeIntentReviewProposal;
      expectedCode: string;
    }> = [
      {
        proposal: makeProposal({
          status: "approved",
          metadata: {
            expiresAt: "2026-06-15T01:29:00.000Z",
          },
        }),
        expectedCode: "proposal_expired",
      },
      {
        proposal: makeProposal({
          status: "approved",
          metadata: {
            revokedAt: "2026-06-15T01:29:30.000Z",
          },
        }),
        expectedCode: "proposal_revoked",
      },
    ];

    for (const testCase of cases) {
      const memoryDir = createInitializedMemory(`manual-confirm-${testCase.expectedCode}-`);
      const paperBroker = createPaperBroker(memoryDir);
      const broker = createManualBroker(memoryDir, paperBroker);

      const result = broker.submitApprovedProposal({
        proposal: testCase.proposal,
        approval: makeApproval(testCase.proposal),
        accountId: "paper-main",
      });

      expect(result).toMatchObject({
        accepted: false,
        delegated: false,
        rejectionCode: testCase.expectedCode,
      });
      expect(paperBroker.getOrders()).toHaveLength(0);
      expect(paperBroker.getTrades()).toHaveLength(0);
    }
  });

  it("reruns PolicyEngine and refuses invalid lot size before paper delegate", () => {
    const memoryDir = createInitializedMemory();
    const paperBroker = createPaperBroker(memoryDir);
    const broker = createManualBroker(memoryDir, paperBroker);
    const proposal = makeProposal({
      status: "approved",
      quantity: 50,
    });

    const result = broker.submitApprovedProposal({
      proposal,
      approval: makeApproval(proposal),
      accountId: "paper-main",
    });

    expect(result.accepted).toBe(false);
    expect(result.delegated).toBe(false);
    expect(result.rejectionCode).toBe("policy_rejected");
    expect(result.policyResult).toMatchObject({
      decision: "rejected",
      reason: {
        code: "invalid_lot_size",
      },
    });
    expect(result.riskResult).toBeUndefined();
    expect(paperBroker.getOrders()).toHaveLength(0);
    expect(lastManualAudit(memoryDir)).toMatchObject({
      metadata: {
        policyResult: {
          decision: "rejected",
          reasonCode: "invalid_lot_size",
        },
        riskResult: null,
        delegated: false,
      },
    });
  });

  it("reruns RiskEngine and refuses position-limit breaches before paper delegate", () => {
    const memoryDir = createInitializedMemory();
    const paperBroker = createPaperBroker(memoryDir);
    const broker = createManualBroker(memoryDir, paperBroker);
    const proposal = makeProposal({
      status: "approved",
      quantity: 2000,
      limitPrice: 10,
    });

    const result = broker.submitApprovedProposal({
      proposal,
      approval: makeApproval(proposal),
      accountId: "paper-main",
    });

    expect(result.accepted).toBe(false);
    expect(result.delegated).toBe(false);
    expect(result.rejectionCode).toBe("risk_rejected");
    expect(result.policyResult?.decision).toBe("passed");
    expect(result.riskResult).toMatchObject({
      decision: "rejected",
      blockingViolations: [
        {
          code: "position_limit_exceeded",
        },
      ],
    });
    expect(paperBroker.getOrders()).toHaveLength(0);
    expect(paperBroker.getTrades()).toHaveLength(0);
    expect(lastManualAudit(memoryDir)).toMatchObject({
      metadata: {
        policyResult: {
          decision: "passed",
        },
        riskResult: {
          decision: "rejected",
          blockingViolationCodes: ["position_limit_exceeded"],
        },
        delegated: false,
      },
    });
  });

  it("does not accept live broker delegates in this phase", () => {
    const memoryDir = createInitializedMemory();
    const paperBroker = createPaperBroker(memoryDir);

    expect(() =>
      new ManualConfirmBroker({
        memoryDir,
        delegate: paperBroker,
        delegateKind: "live" as never,
      }),
    ).toThrow(ManualConfirmBrokerError);
  });
});

function createInitializedMemory(prefix = "secretary-manual-confirm-broker-"): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  const memoryDir = path.join(root, "memory");
  const seed = buildInitialPaperAccountSeed({
    now: baseNow,
    initialCash: 20000,
  });

  initializePaperAccountMemory({ memoryDir, seed, dryRun: false });
  return memoryDir;
}

function createPaperBroker(memoryDir: string): PaperBroker {
  let id = 0;

  return new PaperBroker({
    memoryDir,
    now: () => baseNow,
    idGenerator: () => {
      id += 1;
      return String(id).padStart(4, "0");
    },
  });
}

function createManualBroker(memoryDir: string, delegate: PaperBroker): ManualConfirmBroker {
  let id = 100;

  return new ManualConfirmBroker({
    memoryDir,
    delegate,
    now: () => baseNow,
    idGenerator: () => {
      id += 1;
      return String(id).padStart(4, "0");
    },
  });
}

function makeProposal(
  overrides: Partial<z.input<typeof tradeIntentReviewProposalSchema>> = {},
): TradeIntentReviewProposal {
  const status = overrides.status ?? "approved";

  return tradeIntentReviewProposalSchema.parse({
    proposalId: "proposal-000636-2026-06-15-01-draft-buy",
    proposalType: "trade_intent_review",
    status,
    source: {
      sourceType: "research_report",
      reportId: "research-000636-2026-06-15",
      taskId: "research-task-000636",
      draftId: "draft-buy",
      provider: "trading_agents_cn",
    },
    symbol: "000636",
    market: "SZSE",
    name: "Fenghua Hi-Tech",
    side: "BUY",
    quantity: 100,
    limitPrice: 10,
    currency: "CNY",
    rationale: "Full proposal rationale must not enter audit metadata.",
    reviewReason: "Full review reason must not enter audit metadata.",
    executionGuard: {
      requiresManualReview: true,
      executable: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    },
    createdAt: "2026-06-15T01:00:00.000Z",
    updatedAt: status === "pending_review" ? "2026-06-15T01:00:00.000Z" : baseNowIso,
    createdBy: {
      type: "system",
      id: "test",
    },
    reviewedAt: status === "pending_review" ? undefined : baseNowIso,
    reviewedBy: status === "pending_review"
      ? undefined
      : {
          type: "user",
          id: "operator-001",
        },
    reviewNote: status === "pending_review" ? undefined : "Approved for deterministic checks.",
    metadata: {
      liveTrading: false,
    },
    ...overrides,
  });
}

function makeApproval(proposal: TradeIntentReviewProposal): ManualTradeApproval {
  return {
    approvalId: "approval-000636-001",
    proposalId: proposal.proposalId,
    decision: "approved",
    approvedAt: baseNowIso,
    approvedBy: {
      type: "user",
      id: "operator-001",
    },
    reviewNote: "Approved for paper delegate only.",
  };
}

function readAuditEvents(memoryDir: string) {
  const paths = createPortfolioMemoryPaths(memoryDir, baseNowIso);
  const lines = readFileSync(paths.auditLogPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

  return lines.map((line) => auditEventSchema.parse(JSON.parse(line)));
}

function lastManualAudit(memoryDir: string) {
  const manualEvents = readAuditEvents(memoryDir).filter(
    (event) => event.actor.id === "manual-confirm-broker",
  );

  expect(manualEvents.length).toBeGreaterThan(0);
  return manualEvents.at(-1)!;
}
