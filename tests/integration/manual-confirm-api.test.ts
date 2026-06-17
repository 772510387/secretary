import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTradeIntentReviewProposalsFromResearchReport,
  tradeIntentReviewProposalSchema,
} from "../../src/domain/memory/index.js";
import { researchReportSchema } from "../../src/domain/research/index.js";
import {
  handleManualConfirmRequest,
} from "../../src/interfaces/webhook/index.js";
import {
  ProposalMemoryStore,
  createApprovalMemoryPaths,
  createProposalMemoryPaths,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];
const now = "2026-06-16T01:30:00.000Z";
const token = "manual-confirm-token";

describe("manual confirm API", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("authenticates, records approval, updates proposal, and does not trigger broker", () => {
    const memoryDir = createTempMemoryDir();
    const proposal = seedProposal(memoryDir);
    const result = handleManualConfirmRequest(makeRequest(proposal.proposalId), {
      memoryDir,
      expectedToken: token,
      now,
      idGenerator: createIdGenerator("api"),
    });
    const proposalPaths = createProposalMemoryPaths(memoryDir, proposal.createdAt, proposal.proposalId, now);
    const storedProposal = tradeIntentReviewProposalSchema.parse(
      JSON.parse(readFileSync(proposalPaths.proposalPath, "utf8")),
    );

    expect(result).toMatchObject({
      status: "accepted",
      requestId: "manual-confirm-001",
      accessAudit: {
        result: "accepted",
        tokenLogged: false,
        payloadLogged: false,
      },
      brokerSubmissionAllowed: false,
      liveTradingAllowed: false,
      proposal: {
        status: "approved",
      },
    });
    expect(storedProposal).toMatchObject({
      status: "approved",
      metadata: {
        approvalId: "approval-manual-confirm-001",
        brokerSubmissionAllowed: false,
        directBrokerHandoff: false,
      },
    });
    expect(existsSync(path.join(memoryDir, "portfolio", "orders.jsonl"))).toBe(false);

    const auditText = readFileSync(createApprovalMemoryPaths(memoryDir, now, now).auditLogPath, "utf8");
    expect(auditText).toContain("Manual confirm API accepted");
    expect(auditText).not.toContain(token);
  });

  it("rejects bad token and skips duplicate requestId without another approval write", () => {
    const memoryDir = createTempMemoryDir();
    const proposal = seedProposal(memoryDir);

    const unauthorized = handleManualConfirmRequest(makeRequest(proposal.proposalId, {
      authToken: "wrong-token",
    }), {
      memoryDir,
      expectedToken: token,
      now,
      idGenerator: createIdGenerator("unauth"),
    });
    const accepted = handleManualConfirmRequest(makeRequest(proposal.proposalId), {
      memoryDir,
      expectedToken: token,
      now,
      idGenerator: createIdGenerator("first"),
    });
    const duplicate = handleManualConfirmRequest(makeRequest(proposal.proposalId), {
      memoryDir,
      expectedToken: token,
      now,
      securityState: accepted.nextSecurityState,
      idGenerator: createIdGenerator("dup"),
    });

    expect(unauthorized).toMatchObject({
      status: "unauthorized",
      rejectionReasons: ["auth_failed"],
    });
    expect(duplicate).toMatchObject({
      status: "skipped_duplicate",
      rejectionReasons: ["duplicate_request"],
      brokerSubmissionAllowed: false,
    });

    const approvalsText = readFileSync(createApprovalMemoryPaths(memoryDir, now, now).approvalsPath, "utf8");
    expect(approvalsText.trim().split(/\r?\n/)).toHaveLength(1);
  });
});

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-manual-confirm-api-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function makeRequest(
  proposalId: string,
  overrides: {
    authToken?: string;
    requestId?: string;
  } = {},
) {
  return {
    requestId: overrides.requestId ?? "manual-confirm-001",
    occurredAt: now,
    source: {
      sourceType: "manual",
      sourceId: "local-console",
      operatorId: "operator-001",
    },
    auth: {
      scheme: "bearer",
      token: overrides.authToken ?? token,
      tokenId: "local-token",
    },
    payload: {
      proposalId,
      decision: "approved",
      operatorSessionId: "session-001",
      riskSnapshotRef: "risk/snapshot-001",
      note: "Reviewed manually",
      metadata: {},
    },
  };
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
