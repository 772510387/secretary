import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTradeIntentReviewProposalsFromResearchReport,
  tradeIntentReviewProposalSchema,
} from "../../src/domain/memory/index.js";
import { researchReportSchema } from "../../src/domain/research/index.js";
import {
  ProposalMemoryStore,
  createApprovalMemoryPaths,
  createProposalMemoryPaths,
} from "../../src/infrastructure/storage/index.js";
import {
  main,
  parseManualConfirmArgs,
} from "../../scripts/dev/manual-confirm.js";

const tempRoots: string[] = [];
const now = "2026-06-16T01:30:00.000Z";

describe("manual-confirm dev CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();

    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("parses list and approve commands", () => {
    expect(parseManualConfirmArgs(["list", "--memory-dir", "memory"])).toEqual({
      help: false,
      command: "list",
      memoryDir: "memory",
    });
    expect(parseManualConfirmArgs([
      "approve",
      "--proposal-id",
      "proposal-001",
      "--reviewer-id",
      "operator-001",
      "--operator-session-id",
      "session-001",
      "--risk-snapshot-ref",
      "risk/snapshot-001",
      "--at",
      now,
    ])).toMatchObject({
      help: false,
      command: "approve",
      proposalId: "proposal-001",
      reviewerId: "operator-001",
      operatorSessionId: "session-001",
      riskSnapshotRef: "risk/snapshot-001",
      at: now,
    });
  });

  it("lists pending proposals and approves one without broker handoff", async () => {
    const memoryDir = createTempMemoryDir();
    const proposal = seedProposal(memoryDir);
    const outputs: unknown[] = [];

    vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      outputs.push(JSON.parse(String(value)));
    });

    await main(["list", "--memory-dir", memoryDir]);
    await main([
      "approve",
      "--proposal-id",
      proposal.proposalId,
      "--reviewer-id",
      "operator-001",
      "--operator-session-id",
      "session-001",
      "--risk-snapshot-ref",
      "risk/snapshot-001",
      "--at",
      now,
      "--memory-dir",
      memoryDir,
    ]);

    const listOutput = outputs[0] as { count: number; brokerHandoffTriggered: boolean };
    const approveOutput = outputs[1] as {
      status: string;
      proposalStatus: string;
      brokerHandoffTriggered: boolean;
      brokerConnected: boolean;
    };
    const proposalPaths = createProposalMemoryPaths(memoryDir, proposal.createdAt, proposal.proposalId, now);
    const storedProposal = tradeIntentReviewProposalSchema.parse(
      JSON.parse(readFileSync(proposalPaths.proposalPath, "utf8")),
    );

    expect(listOutput).toMatchObject({
      count: 1,
      brokerHandoffTriggered: false,
    });
    expect(approveOutput).toMatchObject({
      status: "ok",
      proposalStatus: "approved",
      brokerHandoffTriggered: false,
      brokerConnected: false,
    });
    expect(storedProposal.status).toBe("approved");
    expect(readFileSync(createApprovalMemoryPaths(memoryDir, now, now).approvalsPath, "utf8")).toContain(
      "approval-",
    );
    expect(existsSync(path.join(memoryDir, "portfolio", "orders.jsonl"))).toBe(false);
  });
});

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-manual-confirm-cli-"));
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
  }).writeProposal(proposal);

  return proposal;
}
