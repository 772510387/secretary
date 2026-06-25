import { describe, expect, it } from "vitest";
import {
  AsOfMarketReader,
  ForwardOutcomeReader,
  buildReplaySnapshot,
  decideFromSnapshot,
  scoreDecision,
} from "../../src/app/index.js";
import { FixtureHistoryProvider } from "../../src/infrastructure/providers/index.js";
import {
  replayDecisionSchema,
  type DecisionStance,
  type ForwardOutcome,
  type ReplayBias,
  type ReplayDecision,
} from "../../src/domain/decision/index.js";
import {
  REPLAY_MARKET,
  REPLAY_SYMBOL,
  buildReplayBars,
  replayAccount,
  replayPositions,
} from "../fixtures/replay/fixtures.js";

function stance(symbol: string, bias: ReplayBias): DecisionStance {
  return {
    symbol,
    market: "SZSE",
    name: "标的",
    bias,
    confidence: 0.6,
    rationale: "测试",
    basis: { trend: "uptrend", technicalAsOfDate: "2026-06-19", rangePosition60: 0.5, closeVsMa20: 0.01 },
  };
}

function decisionOf(stances: DecisionStance[]): ReplayDecision {
  return replayDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: "dec-x",
    snapshotId: "snap-x",
    accountId: "paper-replay",
    alarmId: "closing-snapshot",
    asOfDate: "2026-06-19",
    asOfTime: "2026-06-19T07:30:00.000Z",
    stances,
    executable: false,
    reviewRequired: true,
    generatedBy: "deterministic-replay-decider",
  });
}

function realized(forwardReturn: number): ForwardOutcome {
  return {
    horizonTradingDays: 5,
    fromDate: "2026-06-19",
    fromClose: 10,
    realized: true,
    toDate: "2026-06-26",
    toClose: Math.round(10 * (1 + forwardReturn) * 100) / 100,
    forwardReturn,
  };
}

function unrealized(): ForwardOutcome {
  return {
    horizonTradingDays: 5,
    fromDate: null,
    fromClose: null,
    realized: false,
    toDate: null,
    toClose: null,
    forwardReturn: null,
  };
}

describe("scoreDecision", () => {
  it("scores increase / reduce / hold against the forward return", () => {
    const decision = decisionOf([
      stance(REPLAY_SYMBOL, "increase"),
      stance("000002", "reduce"),
      stance("000003", "hold"),
    ]);
    const outcomes = new Map<string, ForwardOutcome>([
      [REPLAY_SYMBOL, realized(0.05)], // +5% -> increase correct
      ["000002", realized(0.05)], // +5% -> reduce incorrect
      ["000003", realized(0.001)], // ~flat -> hold correct (threshold 1%)
    ]);

    const scored = scoreDecision(decision, outcomes, { horizonTradingDays: 5, returnThreshold: 0.01 });
    const find = (symbol: string) => scored.stances.find((s) => s.symbol === symbol)!;

    expect(find(REPLAY_SYMBOL).correct).toBe(true);
    expect(find("000002").correct).toBe(false);
    expect(find("000003").correct).toBe(true);
    expect(scored.summary.scoredCount).toBe(3);
    expect(scored.summary.hitCount).toBe(2);
    expect(scored.summary.hitRate).toBeCloseTo(2 / 3, 6);
  });

  it("excludes unrealized stances from the summary (correct = null)", () => {
    const decision = decisionOf([stance(REPLAY_SYMBOL, "increase")]);
    const scored = scoreDecision(decision, new Map([[REPLAY_SYMBOL, unrealized()]]), {
      horizonTradingDays: 5,
      returnThreshold: 0,
    });

    expect(scored.stances[0]!.correct).toBeNull();
    expect(scored.summary.scoredCount).toBe(0);
    expect(scored.summary.hitRate).toBeNull();
    expect(scored.summary.avgForwardReturn).toBeNull();
  });
});

describe("FENCE: future data scores a decision but never feeds it", () => {
  it("yields an identical decision with or without future bars; only the outcome differs", async () => {
    const allBars = buildReplayBars(); // includes future up to 2026-06-22
    const truncated = allBars.filter((bar) => bar.tradeDate <= "2026-06-19"); // no future beyond asOf

    const makeSnapshot = (bars: ReturnType<typeof buildReplayBars>) =>
      buildReplaySnapshot({
        alarmId: "closing-snapshot",
        alarmType: "closing_snapshot",
        jobId: "cerebellum-closing-snapshot",
        beijingTime: "15:30",
        asOfDate: "2026-06-19",
        asOfTime: "2026-06-19T07:30:00.000Z",
        sameDayBarIncluded: true,
        account: replayAccount(),
        positions: replayPositions(),
        reader: new AsOfMarketReader({ historyProvider: new FixtureHistoryProvider({ [REPLAY_SYMBOL]: bars }) }),
      });

    const withFuture = await makeSnapshot(allBars);
    const without = await makeSnapshot(truncated);

    // The as-of snapshot and the decision are identical — future bars cannot leak in.
    expect(withFuture.market.technicals).toEqual(without.market.technicals);
    expect(decideFromSnapshot(withFuture)).toEqual(decideFromSnapshot(without));

    // But the forward outcome is realized only when future bars actually exist.
    const query = {
      symbol: { symbol: REPLAY_SYMBOL, market: REPLAY_MARKET },
      fromDate: "2026-06-19",
      fromClose: withFuture.market.prices[REPLAY_SYMBOL]!,
      horizonTradingDays: 1,
    };
    const withFutureOutcome = await new ForwardOutcomeReader(
      new FixtureHistoryProvider({ [REPLAY_SYMBOL]: allBars }),
    ).getForwardOutcome(query);
    const withoutOutcome = await new ForwardOutcomeReader(
      new FixtureHistoryProvider({ [REPLAY_SYMBOL]: truncated }),
    ).getForwardOutcome(query);

    expect(withFutureOutcome.realized).toBe(true);
    expect(withoutOutcome.realized).toBe(false);
  });
});
