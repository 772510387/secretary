import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryWriteReviewProposal,
  createTradeIntentReviewProposalsFromResearchReport,
  evaluateMemoryWritePolicy,
  memoryWriteRequestSchema,
  memoryWriteReviewProposalSchema,
  tradeIntentReviewProposalSchema,
  type MemoryWriteRequest,
  type TradeIntentReviewProposal,
} from "../../src/domain/memory/index.js";
import {
  researchReportSchema,
  type ResearchReport,
} from "../../src/domain/research/index.js";
import {
  ProposalMemoryStore,
  createProposalMemoryPaths,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];
const generatedAt = "2026-06-12T08:30:00.000Z";
const occurredAt = "2026-06-12T08:31:00.000Z";

describe("ProposalMemoryStore", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("writes trade intent review proposals with metadata-only audit", () => {
    const memoryDir = createTempMemoryDir();
    const store = new ProposalMemoryStore({
      memoryDir,
      now: () => new Date(occurredAt),
      idGenerator: createIdGenerator(),
    });
    const proposal = createTradeIntentReviewProposalsFromResearchReport(makeResearchReport())[0]!;
    const first = store.writeProposal(proposal);
    const second = store.writeProposal(proposal);
    const paths = createProposalMemoryPaths(
      memoryDir,
      proposal.createdAt,
      proposal.proposalId,
      occurredAt,
    );
    const stored = tradeIntentReviewProposalSchema.parse(
      JSON.parse(readFileSync(paths.proposalPath, "utf8")),
    );
    const auditEvents = readJsonLines(paths.auditLogPath);

    expect(first.filePath).toBe(paths.proposalPath);
    expect(first.auditLogPath).toBe(paths.auditLogPath);
    expect(second.backupPath).toBeDefined();
    expect(existsSync(second.backupPath!)).toBe(true);
    expect(second.auditBackupPath).toBeDefined();
    expect(existsSync(second.auditBackupPath!)).toBe(true);
    expect(stored).toMatchObject({
      proposalId: proposal.proposalId,
      proposalType: "trade_intent_review",
      status: "pending_review",
      source: {
        reportId: "research-000636-2026-06-12",
        draftId: "draft-buy-000636",
      },
      executionGuard: {
        requiresManualReview: true,
        executable: false,
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
      },
    });
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0]).toMatchObject({
      actor: {
        type: "system",
        id: "proposal-memory-store",
      },
      action: "suggest",
      subject: {
        type: "memory",
        id: proposal.proposalId,
      },
      severity: "info",
      result: "success",
      correlationId: "research-000636-2026-06-12",
      causationId: "draft-buy-000636",
      metadata: {
        proposalId: proposal.proposalId,
        proposalType: "trade_intent_review",
        status: "pending_review",
        sourceReportId: "research-000636-2026-06-12",
        sourceTaskId: "research-task-000636",
        sourceDraftId: "draft-buy-000636",
        provider: "trading_agents_cn",
        symbol: "000636",
        market: "SZSE",
        side: "BUY",
        hasQuantity: true,
        hasLimitPrice: true,
        requiresManualReview: true,
        executable: false,
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
        filePath: paths.proposalPath,
        backupPath: null,
        liveTrading: false,
      },
    });
    expect(auditEvents[1].metadata).toMatchObject({
      proposalId: proposal.proposalId,
      backupPath: second.backupPath,
    });
    expect(JSON.stringify(auditEvents)).not.toContain(proposal.rationale);
    expect(JSON.stringify(auditEvents)).not.toContain(proposal.reviewReason);
    expect(existsSync(path.join(memoryDir, "portfolio"))).toBe(false);
  });

  it("does not write a proposal or audit when proposal validation fails", () => {
    const memoryDir = createTempMemoryDir();
    const store = new ProposalMemoryStore({
      memoryDir,
      now: () => new Date(occurredAt),
      idGenerator: createIdGenerator(),
    });
    const proposal = createTradeIntentReviewProposalsFromResearchReport(makeResearchReport())[0]!;
    const invalidProposal = {
      ...proposal,
      status: "pending_review",
      reviewedAt: occurredAt,
    } as TradeIntentReviewProposal;
    const paths = createProposalMemoryPaths(
      memoryDir,
      proposal.createdAt,
      proposal.proposalId,
      occurredAt,
    );

    expect(() => store.writeProposal(invalidProposal)).toThrow();
    expect(existsSync(paths.proposalPath)).toBe(false);
    expect(existsSync(paths.auditLogPath)).toBe(false);
  });

  it("writes memory write review proposals with policy metadata-only audit", () => {
    const memoryDir = createTempMemoryDir();
    const store = new ProposalMemoryStore({
      memoryDir,
      now: () => new Date(occurredAt),
      idGenerator: createIdGenerator(),
    });
    const request = makeMemoryWriteRequest();
    const decision = evaluateMemoryWritePolicy(request);
    const proposal = createMemoryWriteReviewProposal(request, decision, {
      now: generatedAt,
    });
    const result = store.writeProposal(proposal);
    const paths = createProposalMemoryPaths(
      memoryDir,
      proposal.createdAt,
      proposal.proposalId,
      occurredAt,
    );
    const stored = memoryWriteReviewProposalSchema.parse(
      JSON.parse(readFileSync(paths.proposalPath, "utf8")),
    );
    const auditEvents = readJsonLines(paths.auditLogPath);

    expect(result.filePath).toBe(paths.proposalPath);
    expect(stored).toMatchObject({
      proposalId: "memory-write-proposal-memory-write-req-001",
      proposalType: "memory_write_review",
      status: "pending_review",
      source: {
        sourceType: "memory_write_request",
        requestId: "memory-write-req-001",
        writeType: "stop_loss_rule_change",
      },
      decision: {
        status: "proposal_required",
        requiresProposal: true,
        autoApplyAllowed: false,
      },
      executionGuard: {
        executable: false,
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
      },
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      actor: {
        type: "system",
        id: "proposal-memory-store",
      },
      action: "suggest",
      subject: {
        type: "memory",
        id: proposal.proposalId,
      },
      correlationId: "memory-write-req-001",
      metadata: {
        proposalId: proposal.proposalId,
        proposalType: "memory_write_review",
        requestId: "memory-write-req-001",
        requestedByType: "brain",
        requestedById: "mock-brain",
        writeType: "stop_loss_rule_change",
        operation: "update",
        targetCategory: "rules",
        targetPath: "memory/rules/risk.md",
        decisionStatus: "proposal_required",
        requiresProposal: true,
        autoApplyAllowed: false,
        executable: false,
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
        filePath: paths.proposalPath,
        backupPath: null,
      },
    });
    expect(JSON.stringify(auditEvents)).not.toContain(request.contentSummary);
    expect(existsSync(path.join(memoryDir, "portfolio"))).toBe(false);
  });
});

function makeResearchReport(): ResearchReport {
  return researchReportSchema.parse({
    reportId: "research-000636-2026-06-12",
    taskId: "research-task-000636",
    provider: "trading_agents_cn",
    symbol: "000636",
    market: "SZSE",
    name: "Fenghua Hi-Tech",
    tradingDate: "2026-06-12",
    generatedAt,
    title: "Research report with drafts",
    summary: "Research summary.",
    conclusion: "mixed",
    confidence: 0.6,
    findings: [],
    bullBearViews: [],
    riskFactors: [],
    sources: [],
    tradeIntentDrafts: [
      {
        draftId: "draft-buy-000636",
        symbol: "000636",
        market: "SZSE",
        name: "Fenghua Hi-Tech",
        side: "BUY",
        quantity: 100,
        limitPrice: 10.5,
        currency: "CNY",
        rationale: "Buy draft for human review only.",
        source: "research",
        requiresReview: true,
        executable: false,
      },
    ],
    requiresHumanReview: true,
    degraded: false,
    metadata: {
      liveTrading: false,
      directExecutionAllowed: false,
    },
  });
}

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-proposal-memory-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function makeMemoryWriteRequest(): MemoryWriteRequest {
  return memoryWriteRequestSchema.parse({
    requestId: "memory-write-req-001",
    requestedAt: generatedAt,
    requestedBy: {
      sourceType: "brain",
      sourceId: "mock-brain",
    },
    writeType: "stop_loss_rule_change",
    operation: "update",
    targetCategory: "rules",
    targetPath: "memory/rules/risk.md",
    title: "调整止损阈值",
    contentSummary: "完整写入正文不应进入审计日志。",
    evidenceRefs: ["memory/reports/2026-06-12/daily_reflection.json"],
    riskControls: {
      weakensHardRule: true,
      touchesLiveTrading: false,
      touchesBrokerBoundary: false,
      touchesAccountOrOrder: false,
      containsSecret: false,
      deletesAudit: false,
      bypassesRisk: false,
      convertsModelOutputToOrder: false,
    },
    metadata: {},
  });
}

function createIdGenerator(): () => string {
  let id = 0;

  return () => {
    id += 1;
    return String(id).padStart(4, "0");
  };
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
