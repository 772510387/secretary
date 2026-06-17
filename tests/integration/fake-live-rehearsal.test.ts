import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApprovalRecord,
  createTradeIntentReviewProposalsFromResearchReport,
} from "../../src/domain/memory/index.js";
import {
  accountSchema,
  type Account,
  type Position,
} from "../../src/domain/portfolio/index.js";
import { researchReportSchema } from "../../src/domain/research/index.js";
import {
  PolicyEngine,
  RiskEngine,
  type PolicyCheckResult,
  type RiskCheckResult,
} from "../../src/domain/risk/index.js";
import {
  createOrderFromIntent,
  tradeIntentSchema,
} from "../../src/domain/trading/index.js";
import {
  FakeBrokerReconciliationService,
  FakeLiveBrokerAdapter,
  LiveTradingGate,
} from "../../src/infrastructure/broker/index.js";
import {
  ApprovalRecordStore,
  LiveTradingSafetyStore,
  ProposalMemoryStore,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];
const now = "2026-06-16T01:30:00.000Z";
const accountId = "live-account-001";

describe("fake live rehearsal", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("runs approved proposal through gate, fake delegate, reconciliation, and audit", async () => {
    const memoryDir = createTempMemoryDir();
    const account = makeAccount();
    const positions: Position[] = [];
    const proposal = seedProposal(memoryDir);
    const approval = createApprovalRecord({
      approvalId: "approval-live-fake-001",
      proposalId: proposal.proposalId,
      decision: "approved",
      reviewer: {
        type: "user",
        id: "operator-001",
      },
      reviewedAt: now,
      operatorSessionId: "session-001",
      riskSnapshotRef: "risk/fake-live-001",
      reviewNote: "Approved for fake live rehearsal only",
      requestId: "manual-confirm-fake-live-001",
      metadata: {
        fakeLiveRehearsal: true,
      },
    });
    const reviewed = new ApprovalRecordStore({
      memoryDir,
      now: () => new Date(now),
      idGenerator: createIdGenerator("approval"),
    }).reviewProposalWithApproval(approval).proposal;
    const intent = tradeIntentSchema.parse({
      intentId: `intent-${reviewed.proposalId}-${approval.approvalId}`,
      accountId,
      symbol: reviewed.proposalType === "trade_intent_review" ? reviewed.symbol : "000636",
      market: reviewed.proposalType === "trade_intent_review" ? reviewed.market : "SZSE",
      name: reviewed.proposalType === "trade_intent_review" ? reviewed.name : "Fenghua Hi-Tech",
      side: "BUY",
      quantity: 100,
      limitPrice: 10,
      currency: "CNY",
      source: "user",
      reason: "fake live rehearsal only",
      createdAt: now,
    });
    const preflightOrder = createOrderFromIntent({
      orderId: "preflight-live-order-001",
      intent,
      now,
    });
    const policyResult = new PolicyEngine().checkOrder({
      order: preflightOrder,
      account,
      positions,
    });
    const riskResult = new RiskEngine().check({
      account,
      positions,
      order: preflightOrder,
      dailyLoss: {
        baselineAssets: 20000,
        currentAssets: 20000,
      },
    });

    seedLiveSafety(memoryDir, policyResult, riskResult);

    const gate = new LiveTradingGate({
      memoryDir,
      now: () => new Date(now),
      idGenerator: createIdGenerator("gate"),
    }).evaluate({
      requestedAt: now,
      liveTradingEnvEnabled: true,
      tradingMode: "live",
      brokerProvider: "fake_live",
      accountId,
      symbol: intent.symbol,
      market: intent.market,
      manualConfirmation: {
        approvalId: approval.approvalId,
        proposalId: approval.proposalId,
        decision: "approved",
        approvedAt: approval.reviewedAt,
        approvedBy: approval.reviewer,
      },
      policyResult,
      riskResult,
    });
    const fakeBroker = new FakeLiveBrokerAdapter({
      account,
      positions,
      now: () => new Date(now),
      idGenerator: createIdGenerator("live"),
    });
    const submit = await fakeBroker.submitOrder({
      requestId: "fake-live-submit-001",
      intent,
      gateResult: gate,
      requestedAt: now,
    });
    const reconciliation = await new FakeBrokerReconciliationService({
      memoryDir,
      broker: fakeBroker,
      now: () => new Date(now),
      idGenerator: createIdGenerator("recon"),
    }).run({
      requestId: "fake-live-reconcile-001",
      accountId,
      local: {
        account,
        positions,
        orders: submit.order ? [submit.order] : [],
        executions: [],
      },
      metadata: {
        fakeLiveRehearsal: true,
        proposalId: proposal.proposalId,
        approvalId: approval.approvalId,
      },
    });

    expect(reviewed.status).toBe("approved");
    expect(policyResult.decision).toBe("passed");
    expect(riskResult.decision).toBe("passed");
    expect(gate.allowed).toBe(true);
    expect(submit).toMatchObject({
      status: "accepted",
      metadata: {
        provider: "fake_live",
        gateAllowed: true,
        brokerConnected: false,
        orderSubmitted: true,
      },
    });
    expect(reconciliation.reconciliation.status).toBe("matched");
    expect(reconciliation.notificationEvent).toBeUndefined();
    expect(existsSync(path.join(memoryDir, "portfolio", "orders.jsonl"))).toBe(false);

    const auditText = readFileSync(path.join(memoryDir, "logs", "audit-2026-06-16.jsonl"), "utf8");
    expect(auditText).toContain("live-trading-gate");
    expect(auditText).toContain("fake-broker-reconciliation-service");
    expect(auditText).toContain("proposal-live-fake");
    expect(auditText).not.toContain("Approved for fake live rehearsal only");
  });
});

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-fake-live-rehearsal-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function makeAccount(): Account {
  return accountSchema.parse({
    accountId,
    type: "live",
    baseCurrency: "CNY",
    initialCash: 20000,
    cash: {
      available: 20000,
      frozen: 0,
    },
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

function seedProposal(memoryDir: string) {
  const proposal = createTradeIntentReviewProposalsFromResearchReport(
    researchReportSchema.parse({
      reportId: "research-fake-live-000636",
      taskId: "task-fake-live-000636",
      provider: "trading_agents_cn",
      symbol: "000636",
      market: "SZSE",
      name: "Fenghua Hi-Tech",
      tradingDate: "2026-06-16",
      generatedAt: now,
      title: "Fake live rehearsal research",
      summary: "Research summary",
      conclusion: "neutral",
      confidence: 0.5,
      findings: [],
      bullBearViews: [],
      riskFactors: [],
      sources: [],
      tradeIntentDrafts: [
        {
          draftId: "draft-fake-live-000636",
          symbol: "000636",
          market: "SZSE",
          name: "Fenghua Hi-Tech",
          side: "BUY",
          quantity: 100,
          limitPrice: 10,
          currency: "CNY",
          rationale: "Fake live rehearsal draft only",
          source: "research",
          requiresReview: true,
          executable: false,
        },
      ],
      requiresHumanReview: true,
      degraded: false,
      metadata: {
        fakeLiveRehearsal: true,
      },
    }),
    {
      now,
      proposalIdPrefix: "proposal-live-fake",
    },
  )[0]!;

  new ProposalMemoryStore({
    memoryDir,
    now: () => new Date(now),
    idGenerator: createIdGenerator("proposal"),
  }).writeProposal(proposal);

  return proposal;
}

function seedLiveSafety(
  memoryDir: string,
  policyResult: PolicyCheckResult,
  riskResult: RiskCheckResult,
): void {
  const store = new LiveTradingSafetyStore({
    memoryDir,
    now: () => new Date(now),
    idGenerator: createIdGenerator("safety"),
  });

  store.writeAllowlist({
    allowlistId: "live-account-allowlist",
    updatedAt: now,
    entries: [
      {
        accountId,
        brokerProvider: "fake_live",
        tradingMode: "live",
        status: "enabled",
        reason: "fake live rehearsal account",
        createdAt: now,
        updatedAt: now,
        metadata: {
          policyDecision: policyResult.decision,
          riskDecision: riskResult.decision,
        },
      },
    ],
    metadata: {},
  });
  store.writeKillSwitch({
    stateId: "kill-switch-state",
    updatedAt: now,
    rules: [],
    metadata: {
      fakeLiveRehearsal: true,
    },
  });
}

function createIdGenerator(prefix: string): () => string {
  let id = 0;

  return () => {
    id += 1;
    return `${prefix}-${String(id).padStart(3, "0")}`;
  };
}
