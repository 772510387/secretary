import { describe, expect, it } from "vitest";
import {
  createTradeIntentReviewProposalsFromResearchReport,
  tradeIntentReviewProposalSchema,
} from "../../src/domain/memory/index.js";
import {
  researchReportSchema,
  type ResearchReport,
} from "../../src/domain/research/index.js";

const generatedAt = "2026-06-12T08:30:00.000Z";

describe("trade intent review proposals", () => {
  it("converts research trade intent drafts into pending manual review proposals", () => {
    const proposals = createTradeIntentReviewProposalsFromResearchReport(makeResearchReport());

    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({
      proposalId: "proposal-000636-2026-06-12-01-draft-buy-000636",
      proposalType: "trade_intent_review",
      status: "pending_review",
      source: {
        sourceType: "research_report",
        reportId: "research-000636-2026-06-12",
        taskId: "research-task-000636",
        draftId: "draft-buy-000636",
        provider: "trading_agents_cn",
      },
      symbol: "000636",
      market: "SZSE",
      side: "BUY",
      quantity: 100,
      limitPrice: 10.5,
      rationale: "Buy draft for human review only.",
      executionGuard: {
        requiresManualReview: true,
        executable: false,
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
      },
      createdAt: generatedAt,
      updatedAt: generatedAt,
      createdBy: {
        type: "system",
        id: "research-proposal-converter",
      },
      metadata: {
        reportId: "research-000636-2026-06-12",
        taskId: "research-task-000636",
        provider: "trading_agents_cn",
        tradingDate: "2026-06-12",
        sourceDraftSide: "BUY",
        requiresHumanReview: true,
        liveTrading: false,
        directExecutionAllowed: false,
      },
    });
    expect(proposals[1]).toMatchObject({
      side: "WATCH",
      quantity: undefined,
      limitPrice: undefined,
      executionGuard: {
        executable: false,
        brokerSubmissionAllowed: false,
      },
    });
  });

  it("returns no proposals when the research report has no trade drafts", () => {
    const proposals = createTradeIntentReviewProposalsFromResearchReport({
      ...makeResearchReport(),
      tradeIntentDrafts: [],
    });

    expect(proposals).toEqual([]);
  });

  it("rejects pending proposals that already look reviewed", () => {
    const proposal = createTradeIntentReviewProposalsFromResearchReport(makeResearchReport())[0]!;

    expect(
      tradeIntentReviewProposalSchema.safeParse({
        ...proposal,
        reviewedAt: generatedAt,
      }).success,
    ).toBe(false);
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
    findings: [
      {
        findingId: "finding-0001",
        category: "fundamental",
        statement: "Revenue recovery needs confirmation.",
        evidence: ["Mock evidence"],
        confidence: 0.6,
      },
    ],
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
      {
        draftId: "draft-watch-000636",
        symbol: "000636",
        market: "SZSE",
        name: "Fenghua Hi-Tech",
        side: "WATCH",
        currency: "CNY",
        rationale: "Watch draft for human review only.",
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
