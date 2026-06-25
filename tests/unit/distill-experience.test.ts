import { describe, expect, it } from "vitest";
import {
  bucketOf,
  distillSoftExperience,
  findSoftLesson,
  findSoftLessonsByRegime,
  isExperienceUsableAt,
} from "../../src/app/index.js";
import {
  scoredDecisionSchema,
  type DecisionStance,
  type ReplayBias,
  type ScoredDecision,
  type ScoredStance,
} from "../../src/domain/decision/index.js";

interface StanceSpec {
  symbol: string;
  trend: DecisionStance["basis"]["trend"];
  rangePosition60: number | null;
  bias: ReplayBias;
  forwardReturn: number;
  correct: boolean;
}

function realizedStance(spec: StanceSpec): ScoredStance {
  return {
    symbol: spec.symbol,
    market: "SZSE",
    name: "标的",
    bias: spec.bias,
    confidence: 0.5,
    rationale: "测试",
    basis: {
      trend: spec.trend,
      technicalAsOfDate: "2026-06-19",
      rangePosition60: spec.rangePosition60,
      closeVsMa20: null,
    },
    forwardOutcome: {
      horizonTradingDays: 1,
      fromDate: "2026-06-18",
      fromClose: 10,
      realized: true,
      toDate: "2026-06-19",
      toClose: Math.round(10 * (1 + spec.forwardReturn) * 100) / 100,
      forwardReturn: spec.forwardReturn,
    },
    correct: spec.correct,
  };
}

function scoredOf(stances: ScoredStance[]): ScoredDecision {
  const hits = stances.filter((stance) => stance.correct === true).length;
  return scoredDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: "dec-x",
    snapshotId: "snap-x",
    accountId: "paper-replay",
    alarmId: "closing-snapshot",
    asOfDate: "2026-06-19",
    asOfTime: "2026-06-19T07:30:00.000Z",
    horizonTradingDays: 1,
    returnThreshold: 0,
    stances,
    summary: {
      scoredCount: stances.length,
      hitCount: hits,
      hitRate: stances.length > 0 ? hits / stances.length : null,
      avgForwardReturn: 0,
    },
    executable: false,
    reviewRequired: true,
    generatedBy: "deterministic-replay-decider",
    scoredBy: "forward-return-scorer",
  });
}

function distill(stances: ScoredStance[]) {
  return distillSoftExperience({
    scored: [scoredOf(stances)],
    startDate: "2026-06-18",
    endDate: "2026-06-19",
    horizonTradingDays: 1,
    returnThreshold: 0,
  });
}

describe("bucketOf (60-day range buckets)", () => {
  it("maps range position to buckets at the right boundaries", () => {
    expect(bucketOf(null)).toBe("unknown");
    expect(bucketOf(0.2)).toBe("low");
    expect(bucketOf(0.33)).toBe("mid");
    expect(bucketOf(0.65)).toBe("mid");
    expect(bucketOf(0.66)).toBe("high");
    expect(bucketOf(0.84)).toBe("high");
    expect(bucketOf(0.85)).toBe("near_high");
    expect(bucketOf(0.99)).toBe("near_high");
  });
});

describe("distillSoftExperience", () => {
  it("is advisory only (never a hard rule)", () => {
    const report = distill([
      realizedStance({ symbol: "000001", trend: "uptrend", rangePosition60: 0.5, bias: "increase", forwardReturn: 0.05, correct: true }),
    ]);
    expect(report.advisoryOnly).toBe(true);
    expect(report.generatedBy).toBe("soft-experience-distiller");
  });

  it("classifies a winning regime as favorable", () => {
    const report = distill([
      realizedStance({ symbol: "000001", trend: "uptrend", rangePosition60: 0.5, bias: "increase", forwardReturn: 0.05, correct: true }),
      realizedStance({ symbol: "000002", trend: "uptrend", rangePosition60: 0.5, bias: "increase", forwardReturn: 0.04, correct: true }),
      realizedStance({ symbol: "000003", trend: "uptrend", rangePosition60: 0.5, bias: "increase", forwardReturn: 0.03, correct: true }),
    ]);
    expect(report.lessons).toHaveLength(1);
    expect(report.lessons[0]!.regime).toEqual({ trend: "uptrend", rangeBucket: "mid", bias: "increase" });
    expect(report.lessons[0]!.verdict).toBe("favorable");
    expect(report.lessons[0]!.hitRate).toBe(1);
    expect(report.lessons[0]!.sampleSize).toBe(3);
  });

  it("classifies a losing regime as unfavorable", () => {
    const report = distill([
      realizedStance({ symbol: "000001", trend: "uptrend", rangePosition60: 0.95, bias: "reduce", forwardReturn: 0.05, correct: false }),
      realizedStance({ symbol: "000002", trend: "uptrend", rangePosition60: 0.95, bias: "reduce", forwardReturn: 0.04, correct: false }),
      realizedStance({ symbol: "000003", trend: "uptrend", rangePosition60: 0.95, bias: "reduce", forwardReturn: 0.03, correct: false }),
    ]);
    expect(report.lessons[0]!.regime.rangeBucket).toBe("near_high");
    expect(report.lessons[0]!.verdict).toBe("unfavorable");
    expect(report.lessons[0]!.hitRate).toBe(0);
    expect(report.lessons[0]!.advice).toContain("建议");
  });

  it("marks a 50% regime as mixed and a too-small regime as insufficient", () => {
    const mixed = distill([
      realizedStance({ symbol: "000001", trend: "sideways", rangePosition60: 0.5, bias: "hold", forwardReturn: 0.0, correct: true }),
      realizedStance({ symbol: "000002", trend: "sideways", rangePosition60: 0.5, bias: "hold", forwardReturn: 0.0, correct: true }),
      realizedStance({ symbol: "000003", trend: "sideways", rangePosition60: 0.5, bias: "hold", forwardReturn: 0.1, correct: false }),
      realizedStance({ symbol: "000004", trend: "sideways", rangePosition60: 0.5, bias: "hold", forwardReturn: 0.1, correct: false }),
    ]);
    expect(mixed.lessons[0]!.verdict).toBe("mixed");

    const insufficient = distill([
      realizedStance({ symbol: "000001", trend: "downtrend", rangePosition60: 0.2, bias: "reduce", forwardReturn: -0.05, correct: true }),
      realizedStance({ symbol: "000002", trend: "downtrend", rangePosition60: 0.2, bias: "reduce", forwardReturn: -0.05, correct: true }),
    ]);
    expect(insufficient.lessons[0]!.verdict).toBe("insufficient");
  });

  it("findSoftLesson looks up the matching regime", () => {
    const report = distill([
      realizedStance({ symbol: "000001", trend: "uptrend", rangePosition60: 0.95, bias: "reduce", forwardReturn: 0.05, correct: false }),
      realizedStance({ symbol: "000002", trend: "uptrend", rangePosition60: 0.95, bias: "reduce", forwardReturn: 0.04, correct: false }),
      realizedStance({ symbol: "000003", trend: "uptrend", rangePosition60: 0.95, bias: "reduce", forwardReturn: 0.03, correct: false }),
    ]);
    const lesson = findSoftLesson(report, { trend: "uptrend", rangePosition60: 0.92, bias: "reduce" });
    expect(lesson?.verdict).toBe("unfavorable");
    expect(findSoftLesson(report, { trend: "downtrend", rangePosition60: 0.1, bias: "increase" })).toBeNull();
  });

  it("computes coverageThroughDate and enforces the strict temporal fence", () => {
    const report = distill([
      realizedStance({ symbol: "000001", trend: "uptrend", rangePosition60: 0.5, bias: "increase", forwardReturn: 0.05, correct: true }),
    ]);
    expect(report.coverageThroughDate).toBe("2026-06-19"); // realizedStance's toDate

    expect(isExperienceUsableAt(report, "2026-06-20")).toBe(true);
    expect(isExperienceUsableAt(report, "2026-06-19")).toBe(false); // must be STRICTLY after
    expect(isExperienceUsableAt(report, "2026-06-18")).toBe(false);
  });

  it("findSoftLessonsByRegime returns all bias variants for a (trend, bucket)", () => {
    const report = distill([
      realizedStance({ symbol: "000001", trend: "uptrend", rangePosition60: 0.5, bias: "increase", forwardReturn: 0.05, correct: true }),
      realizedStance({ symbol: "000002", trend: "uptrend", rangePosition60: 0.5, bias: "increase", forwardReturn: 0.05, correct: true }),
      realizedStance({ symbol: "000003", trend: "uptrend", rangePosition60: 0.5, bias: "increase", forwardReturn: 0.05, correct: true }),
      realizedStance({ symbol: "000004", trend: "uptrend", rangePosition60: 0.55, bias: "reduce", forwardReturn: 0.05, correct: false }),
      realizedStance({ symbol: "000005", trend: "uptrend", rangePosition60: 0.55, bias: "reduce", forwardReturn: 0.05, correct: false }),
      realizedStance({ symbol: "000006", trend: "uptrend", rangePosition60: 0.55, bias: "reduce", forwardReturn: 0.05, correct: false }),
    ]);
    const lessons = findSoftLessonsByRegime(report, { trend: "uptrend", rangePosition60: 0.5 });
    expect(lessons.map((lesson) => lesson.regime.bias).sort()).toEqual(["increase", "reduce"]);
    expect(findSoftLessonsByRegime(report, { trend: "downtrend", rangePosition60: 0.5 })).toHaveLength(0);
  });

  it("ignores unrealized stances entirely", () => {
    const decision = scoredDecisionSchema.parse({
      schemaVersion: 1,
      decisionId: "dec-x",
      snapshotId: "snap-x",
      accountId: "paper-replay",
      alarmId: "closing-snapshot",
      asOfDate: "2026-06-19",
      asOfTime: "2026-06-19T07:30:00.000Z",
      horizonTradingDays: 1,
      returnThreshold: 0,
      stances: [
        {
          symbol: "000001",
          market: "SZSE",
          name: "标的",
          bias: "hold",
          confidence: 0.5,
          rationale: "测试",
          basis: { trend: "uptrend", technicalAsOfDate: "2026-06-19", rangePosition60: 0.5, closeVsMa20: null },
          forwardOutcome: {
            horizonTradingDays: 1,
            fromDate: null,
            fromClose: null,
            realized: false,
            toDate: null,
            toClose: null,
            forwardReturn: null,
          },
          correct: null,
        },
      ],
      summary: { scoredCount: 0, hitCount: 0, hitRate: null, avgForwardReturn: null },
      executable: false,
      reviewRequired: true,
      generatedBy: "deterministic-replay-decider",
      scoredBy: "forward-return-scorer",
    });
    const report = distillSoftExperience({
      scored: [decision],
      startDate: "2026-06-18",
      endDate: "2026-06-19",
      horizonTradingDays: 1,
      returnThreshold: 0,
    });
    expect(report.scoredStances).toBe(0);
    expect(report.lessons).toHaveLength(0);
  });
});
