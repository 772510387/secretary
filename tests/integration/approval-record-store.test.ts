import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditEventSchema } from "../../src/domain/audit/index.js";
import {
  createApprovalRecord,
  createTradeIntentReviewProposalsFromResearchReport,
  tradeIntentReviewProposalSchema,
} from "../../src/domain/memory/index.js";
import {
  researchReportSchema,
} from "../../src/domain/research/index.js";
import {
  ApprovalRecordStore,
  ProposalMemoryStore,
  createApprovalMemoryPaths,
  createProposalMemoryPaths,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];
const now = "2026-06-16T01:30:00.000Z";

describe("ApprovalRecordStore", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("appends ApprovalRecord, updates proposal status, and audits metadata only", () => {
    const memoryDir = createTempMemoryDir();
    const proposal = seedProposal(memoryDir);
    const store = new ApprovalRecordStore({
      memoryDir,
      now: () => new Date(now),
      idGenerator: createIdGenerator("approval"),
    });
    const approval = createApprovalRecord({
      approvalId: "approval-001",
      proposalId: proposal.proposalId,
      decision: "approved",
      reviewer: {
        type: "user",
        id: "operator-001",
      },
      reviewedAt: now,
      operatorSessionId: "session-001",
      riskSnapshotRef: "risk/snapshot-001",
      reviewNote: "Approved after manual review",
      requestId: "manual-confirm-001",
      metadata: {},
    });
    const result = store.reviewProposalWithApproval(approval);
    const approvalPaths = createApprovalMemoryPaths(memoryDir, now, now);
    const proposalPaths = createProposalMemoryPaths(memoryDir, proposal.createdAt, proposal.proposalId, now);
    const storedProposal = tradeIntentReviewProposalSchema.parse(
      JSON.parse(readFileSync(proposalPaths.proposalPath, "utf8")),
    );
    const approvalsText = readFileSync(approvalPaths.approvalsPath, "utf8");
    const auditText = readFileSync(approvalPaths.auditLogPath, "utf8");
    const auditEvents = auditText
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => auditEventSchema.parse(JSON.parse(line)));

    expect(result.approvalWrite.filePath).toBe(approvalPaths.approvalsPath);
    expect(result.proposalWrite.filePath).toBe(proposalPaths.proposalPath);
    expect(storedProposal).toMatchObject({
      proposalId: proposal.proposalId,
      status: "approved",
      reviewedAt: now,
      reviewedBy: {
        type: "user",
        id: "operator-001",
      },
      executionGuard: {
        executable: false,
        brokerSubmissionAllowed: false,
        liveTradingAllowed: false,
      },
      metadata: {
        approvalId: "approval-001",
        operatorSessionId: "session-001",
        riskSnapshotRef: "risk/snapshot-001",
        brokerSubmissionAllowed: false,
        directBrokerHandoff: false,
      },
    });
    expect(approvalsText).toContain("approval-001");
    expect(auditEvents.some((event) => event.actor.id === "approval-record-store")).toBe(true);
    expect(auditText).toContain("brokerSubmissionAllowed");
    expect(auditText).not.toContain("Approved after manual review");
    expect(existsSync(path.join(memoryDir, "portfolio", "orders.jsonl"))).toBe(false);
  });

  it("rejects approval records that contain token-like values", () => {
    const memoryDir = createTempMemoryDir();
    const proposal = seedProposal(memoryDir);
    const store = new ApprovalRecordStore({
      memoryDir,
      now: () => new Date(now),
    });

    expect(() =>
      store.writeApproval(createApprovalRecord({
        approvalId: "approval-secret",
        proposalId: proposal.proposalId,
        decision: "rejected",
        reviewer: {
          type: "user",
          id: "operator-001",
        },
        reviewedAt: now,
        operatorSessionId: "session-001",
        riskSnapshotRef: "risk/snapshot-001",
        reviewNote: "token=raw-token should fail",
        metadata: {},
      })),
    ).toThrow(/must not contain/);
  });
});

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-approval-record-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function seedProposal(memoryDir: string) {
  const proposal = createTradeIntentReviewProposalsFromResearchReport(
    researchReportSchema.parse({
      reportId: "research-000636",
      taskId: "task-000636",
      provider: "trading_agents_cn",
      symbol: "000636",
      market: "SZSE",
      name: "Fenghua Hi-Tech",
      tradingDate: "2026-06-16",
      generatedAt: now,
      title: "Research report",
      summary: "Research summary",
      conclusion: "neutral",
      confidence: 0.5,
      findings: [],
      bullBearViews: [],
      riskFactors: [],
      sources: [],
      tradeIntentDrafts: [
        {
          draftId: "draft-000636",
          symbol: "000636",
          market: "SZSE",
          name: "Fenghua Hi-Tech",
          side: "BUY",
          quantity: 100,
          limitPrice: 10,
          currency: "CNY",
          rationale: "Draft only",
          source: "research",
          requiresReview: true,
          executable: false,
        },
      ],
      requiresHumanReview: true,
      degraded: false,
      metadata: {},
    }),
    {
      now,
      proposalIdPrefix: "proposal",
    },
  )[0]!;

  new ProposalMemoryStore({
    memoryDir,
    now: () => new Date(now),
    idGenerator: createIdGenerator("proposal"),
  }).writeProposal(proposal);

  return proposal;
}

function createIdGenerator(prefix: string): () => string {
  let id = 0;

  return () => {
    id += 1;
    return `${prefix}-${String(id).padStart(3, "0")}`;
  };
}
