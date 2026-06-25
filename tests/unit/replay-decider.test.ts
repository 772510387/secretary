import { describe, expect, it } from "vitest";
import { AsOfMarketReader, buildReplaySnapshot, classifyReplayBias, decideFromSnapshot } from "../../src/app/index.js";
import { FixtureHistoryProvider } from "../../src/infrastructure/providers/index.js";
import {
  replayAccount,
  replayBarsBySymbol,
  replayPositions,
} from "../fixtures/replay/fixtures.js";

describe("classifyReplayBias (deterministic rule)", () => {
  it("uptrend with room below the 60-day high -> increase", () => {
    expect(classifyReplayBias("uptrend", 0.5)).toEqual({ bias: "increase", confidence: 0.6 });
  });

  it("uptrend pinned near the 60-day high -> reduce (do not chase)", () => {
    expect(classifyReplayBias("uptrend", 0.95)).toEqual({ bias: "reduce", confidence: 0.6 });
  });

  it("downtrend -> reduce", () => {
    expect(classifyReplayBias("downtrend", 0.3)).toEqual({ bias: "reduce", confidence: 0.6 });
  });

  it("sideways mid-range -> hold", () => {
    expect(classifyReplayBias("sideways", 0.5)).toEqual({ bias: "hold", confidence: 0.4 });
  });

  it("insufficient data / no range -> low-confidence hold", () => {
    expect(classifyReplayBias("insufficient_data", null)).toEqual({ bias: "hold", confidence: 0.2 });
    expect(classifyReplayBias("uptrend", null)).toEqual({ bias: "hold", confidence: 0.2 });
  });
});

describe("decideFromSnapshot (as-of, never executable)", () => {
  it("produces a review-required, non-executable decision per held position", async () => {
    const reader = new AsOfMarketReader({
      historyProvider: new FixtureHistoryProvider(replayBarsBySymbol()),
    });
    const snapshot = await buildReplaySnapshot({
      alarmId: "closing-snapshot",
      alarmType: "closing_snapshot",
      jobId: "cerebellum-closing-snapshot",
      beijingTime: "15:30",
      asOfDate: "2026-06-19",
      asOfTime: "2026-06-19T07:30:00.000Z",
      sameDayBarIncluded: true,
      account: replayAccount(),
      positions: replayPositions(),
      reader,
    });

    const decision = decideFromSnapshot(snapshot);

    expect(decision.executable).toBe(false);
    expect(decision.reviewRequired).toBe(true);
    expect(decision.decisionId).toBe(snapshot.snapshotId.replace(/^snap-/, "dec-"));
    expect(decision.stances).toHaveLength(1);
    // The fixture is a monotonic uptrend pinned at the 60-day high -> trim.
    expect(decision.stances[0]!.bias).toBe("reduce");
    expect(decision.stances[0]!.basis.technicalAsOfDate).toBe("2026-06-19");
  });

  it("is a pure function of the snapshot (same snapshot -> identical decision)", async () => {
    const reader = new AsOfMarketReader({
      historyProvider: new FixtureHistoryProvider(replayBarsBySymbol()),
    });
    const snapshot = await buildReplaySnapshot({
      alarmId: "closing-snapshot",
      alarmType: "closing_snapshot",
      jobId: "cerebellum-closing-snapshot",
      beijingTime: "15:30",
      asOfDate: "2026-06-19",
      asOfTime: "2026-06-19T07:30:00.000Z",
      sameDayBarIncluded: true,
      account: replayAccount(),
      positions: replayPositions(),
      reader,
    });

    expect(decideFromSnapshot(snapshot)).toEqual(decideFromSnapshot(snapshot));
  });
});
