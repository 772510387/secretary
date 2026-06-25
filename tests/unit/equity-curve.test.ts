import { describe, expect, it } from "vitest";
import { computeEquityCurve } from "../../src/app/index.js";
import {
  scoredDecisionSchema,
  type ReplayBias,
  type ScoredDecision,
} from "../../src/domain/decision/index.js";

interface StanceSpec {
  bias: ReplayBias;
  forwardReturn: number | null; // null => unrealized
}

function scoredAt(asOfDate: string, stances: StanceSpec[]): ScoredDecision {
  return scoredDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: `dec-${asOfDate}`,
    snapshotId: `snap-${asOfDate}`,
    accountId: "paper-replay",
    alarmId: "closing-snapshot",
    asOfDate,
    asOfTime: `${asOfDate}T07:30:00.000Z`,
    horizonTradingDays: 1,
    returnThreshold: 0,
    stances: stances.map((spec, index) => ({
      symbol: `00000${index + 1}`,
      market: "SZSE",
      name: "标的",
      bias: spec.bias,
      confidence: 0.5,
      rationale: "测试",
      basis: { trend: "uptrend", technicalAsOfDate: asOfDate, rangePosition60: 0.5, closeVsMa20: null },
      forwardOutcome:
        spec.forwardReturn === null
          ? { horizonTradingDays: 1, fromDate: null, fromClose: null, realized: false, toDate: null, toClose: null, forwardReturn: null }
          : {
              horizonTradingDays: 1,
              fromDate: asOfDate,
              fromClose: 10,
              realized: true,
              toDate: "2026-12-31",
              toClose: Math.round(10 * (1 + spec.forwardReturn) * 100) / 100,
              forwardReturn: spec.forwardReturn,
            },
      correct: spec.forwardReturn === null ? null : true,
    })),
    summary: { scoredCount: 0, hitCount: 0, hitRate: null, avgForwardReturn: null },
    executable: false,
    reviewRequired: true,
    generatedBy: "deterministic-replay-decider",
    scoredBy: "forward-return-scorer",
  });
}

describe("computeEquityCurve (directional proxy)", () => {
  it("compounds increase signals and tracks drawdown", () => {
    const curve = computeEquityCurve([
      scoredAt("2026-06-01", [{ bias: "increase", forwardReturn: 0.1 }]), // +10% -> 1.1
      scoredAt("2026-06-02", [{ bias: "increase", forwardReturn: -0.2 }]), // -20% -> 0.88
    ]);

    expect(curve.tradingDays).toBe(2);
    expect(curve.points[0]!.equity).toBe(1.1);
    expect(curve.points[1]!.equity).toBe(0.88);
    expect(curve.endEquity).toBe(0.88);
    expect(curve.totalReturn).toBe(-0.12);
    expect(curve.maxDrawdown).toBe(0.2); // (1.1 - 0.88) / 1.1
  });

  it("flips the sign for reduce and zeroes hold, averaging per date", () => {
    const curve = computeEquityCurve([
      scoredAt("2026-06-01", [
        { bias: "reduce", forwardReturn: 0.1 }, // -> -0.1
        { bias: "hold", forwardReturn: 0.5 }, // -> 0
      ]),
    ]);
    expect(curve.points[0]!.signal).toBe(-0.05); // mean(-0.1, 0)
    expect(curve.endEquity).toBe(0.95);
  });

  it("floors extreme negative signals so equity stays positive and drawdown stays in [0,1]", () => {
    // "reduce" while the stock tripled -> signed return -2.0 -> floored to -0.99.
    const curve = computeEquityCurve([scoredAt("2026-06-01", [{ bias: "reduce", forwardReturn: 2.0 }])]);
    expect(curve.points[0]!.signal).toBe(-0.99);
    expect(curve.endEquity).toBeGreaterThan(0);
    expect(curve.endEquity).toBeCloseTo(0.01, 6);
    expect(curve.maxDrawdown).toBeLessThanOrEqual(1);
    expect(curve.maxDrawdown).toBeGreaterThanOrEqual(0);
  });

  it("ignores unrealized stances (no phantom equity moves)", () => {
    const curve = computeEquityCurve([scoredAt("2026-06-01", [{ bias: "increase", forwardReturn: null }])]);
    expect(curve.tradingDays).toBe(0);
    expect(curve.endEquity).toBe(1);
    expect(curve.totalReturn).toBe(0);
    expect(curve.maxDrawdown).toBe(0);
  });
});
