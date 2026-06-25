import { describe, expect, it } from "vitest";
import {
  AsOfMarketReader,
  ForwardOutcomeReader,
  ModelReplayDecider,
  buildReplaySnapshot,
  compareDeciders,
  deterministicReplayDecider,
} from "../../src/app/index.js";
import { FixtureHistoryProvider } from "../../src/infrastructure/providers/index.js";
import type { BrainInput, BrainOutput, BrainProvider } from "../../src/domain/brain/index.js";
import type { JsonValue } from "../../src/domain/shared/index.js";
import type { PointInTimeSnapshot } from "../../src/domain/portfolio/index.js";
import {
  REPLAY_SYMBOL,
  replayAccount,
  replayBarsBySymbol,
  replayPositions,
} from "../fixtures/replay/fixtures.js";

class StubBrain implements BrainProvider {
  readonly providerName = "mock" as const;
  constructor(private readonly structured: JsonValue) {}
  async generate(input: BrainInput): Promise<BrainOutput> {
    return {
      requestId: input.requestId,
      provider: this.providerName,
      model: "mock",
      taskType: input.taskType,
      generatedAt: "2026-06-19T07:30:00.000Z",
      summary: "",
      structured: this.structured,
      citations: [],
      confidence: 0.5,
      proposals: [],
    };
  }
}

async function snapshot(): Promise<PointInTimeSnapshot> {
  const reader = new AsOfMarketReader({
    historyProvider: new FixtureHistoryProvider(replayBarsBySymbol()),
  });
  return buildReplaySnapshot({
    alarmId: "post-close-review",
    alarmType: "post_close_review",
    jobId: "cerebellum-post-close-review",
    beijingTime: "15:30",
    asOfDate: "2026-06-19",
    asOfTime: "2026-06-19T07:30:00.000Z",
    sameDayBarIncluded: true,
    account: replayAccount(),
    positions: replayPositions(),
    reader,
  });
}

describe("compareDeciders", () => {
  it("scores the same snapshots through each strategy and picks the best", async () => {
    const alwaysIncrease = new ModelReplayDecider(
      new StubBrain({ stances: [{ symbol: REPLAY_SYMBOL, bias: "increase" }] }),
    );

    const report = await compareDeciders({
      snapshots: [await snapshot()],
      strategies: [
        { name: "deterministic", decider: deterministicReplayDecider },
        { name: "always-increase", decider: alwaysIncrease },
      ],
      forwardReader: new ForwardOutcomeReader(new FixtureHistoryProvider(replayBarsBySymbol())),
      startDate: "2026-06-19",
      endDate: "2026-06-19",
      horizonTradingDays: 1,
      returnThreshold: 0,
    });

    const byName = (name: string) => report.strategies.find((strategy) => strategy.name === name)!;
    // The fixture keeps rising: "reduce" (deterministic, near 60d high) misses, "increase" hits.
    expect(byName("deterministic").hitRate).toBe(0);
    expect(byName("always-increase").hitRate).toBe(1);
    expect(report.best).toBe("always-increase");
    expect(report.advisoryOnly).toBe(true);
    expect(report.strategies).toHaveLength(2);
  });
});
