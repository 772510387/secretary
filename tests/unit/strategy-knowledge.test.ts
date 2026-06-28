import { describe, expect, it } from "vitest";
import {
  buildStrategyKnowledgeDigest,
  renderStrategyKnowledgeDigest,
} from "../../src/app/index.js";
import {
  scoredDecisionSchema,
  type ReplayBias,
  type ScoredDecision,
  type ScoredStance,
} from "../../src/domain/decision/index.js";
import { deriveStrategyIdsForStance } from "../../src/domain/strategy/index.js";

function stance(input: {
  symbol: string;
  bias: ReplayBias;
  rangePosition60: number;
  forwardReturn: number;
  correct: boolean;
  strategyIds?: string[];
}): ScoredStance {
  return {
    symbol: input.symbol,
    market: "SZSE",
    name: `标的${input.symbol}`,
    bias: input.bias,
    confidence: 0.6,
    rationale: "测试策略归因",
    basis: {
      trend: "uptrend",
      technicalAsOfDate: "2026-06-24",
      rangePosition60: input.rangePosition60,
      closeVsMa20: 0.01,
    },
    strategyIds: input.strategyIds,
    forwardOutcome: {
      horizonTradingDays: 1,
      fromDate: "2026-06-24",
      fromClose: 10,
      realized: true,
      toDate: "2026-06-25",
      toClose: Math.round(10 * (1 + input.forwardReturn) * 100) / 100,
      forwardReturn: input.forwardReturn,
    },
    correct: input.correct,
  };
}

function decision(decisionId: string, stances: ScoredStance[]): ScoredDecision {
  const hits = stances.filter((item) => item.correct === true).length;
  const avg = stances.reduce((sum, item) => sum + (item.forwardOutcome.forwardReturn ?? 0), 0) / stances.length;
  return scoredDecisionSchema.parse({
    schemaVersion: 1,
    decisionId,
    snapshotId: decisionId.replace(/^dec-/, "snap-"),
    accountId: "paper-main",
    alarmId: "post-close-review",
    asOfDate: "2026-06-24",
    asOfTime: "2026-06-24T07:30:00.000Z",
    horizonTradingDays: 1,
    returnThreshold: 0,
    stances,
    summary: {
      scoredCount: stances.length,
      hitCount: hits,
      hitRate: hits / stances.length,
      avgForwardReturn: avg,
    },
    executable: false,
    reviewRequired: true,
    generatedBy: "deterministic-replay-decider",
    scoredBy: "forward-return-scorer",
  });
}

describe("strategy knowledge", () => {
  it("derives human-facing strategy ids from a stance regime", () => {
    expect(
      deriveStrategyIdsForStance({
        bias: "increase",
        basis: {
          trend: "uptrend",
          rangePosition60: 0.2,
        },
      }),
    ).toEqual(["BUY-001"]);

    expect(
      deriveStrategyIdsForStance({
        bias: "reduce",
        basis: {
          trend: "uptrend",
          rangePosition60: 0.92,
        },
      }),
    ).toEqual(["SELL-001"]);
  });

  it("builds strategy metrics, cases, and decision links from scored decisions", () => {
    const digest = buildStrategyKnowledgeDigest({
      scoredDecisions: [
        decision("dec-a", [
          stance({ symbol: "000001", bias: "increase", rangePosition60: 0.2, forwardReturn: 0.03, correct: true, strategyIds: ["BUY-001"] }),
          stance({ symbol: "000002", bias: "increase", rangePosition60: 0.2, forwardReturn: 0.04, correct: true, strategyIds: ["BUY-001"] }),
          stance({ symbol: "000003", bias: "increase", rangePosition60: 0.2, forwardReturn: 0.05, correct: true, strategyIds: ["BUY-001"] }),
          stance({ symbol: "000004", bias: "reduce", rangePosition60: 0.95, forwardReturn: 0.05, correct: false, strategyIds: ["SELL-001"] }),
        ]),
      ],
      maxCases: 4,
      asOfDate: "2026-06-25",
    });

    const buy001 = digest.strategies.find((item) => item.strategyId === "BUY-001")!;
    expect(buy001.metrics.sampleSize).toBe(3);
    expect(buy001.metrics.hitRate).toBe(1);
    expect(buy001.metrics.lifecycleSuggestion).toBe("建议提炼");

    const sell001 = digest.strategies.find((item) => item.strategyId === "SELL-001")!;
    expect(sell001.metrics.sampleSize).toBe(1);
    expect(sell001.metrics.lifecycleSuggestion).toBe("待验证");

    expect(digest.cases).toHaveLength(4);
    expect(digest.decisions.some((item) => item.strategyIds.includes("SELL-001"))).toBe(true);

    const rendered = renderStrategyKnowledgeDigest(digest);
    expect(rendered).toContain("策略知识库总览");
    expect(rendered).toContain("BUY-001");
    expect(rendered).toContain("增长机制");
  });
});
