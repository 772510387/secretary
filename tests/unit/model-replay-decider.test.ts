import { describe, expect, it } from "vitest";
import {
  AsOfMarketReader,
  ForwardOutcomeReader,
  ModelReplayDecider,
  buildReplaySnapshot,
  scoreReplaySnapshots,
} from "../../src/app/index.js";
import { FixtureHistoryProvider } from "../../src/infrastructure/providers/index.js";
import type { BrainInput, BrainOutput, BrainProvider } from "../../src/domain/brain/index.js";
import type { PointInTimeSnapshot } from "../../src/domain/portfolio/index.js";
import type { JsonValue } from "../../src/domain/shared/index.js";
import {
  softExperienceReportSchema,
  type SoftExperienceReport,
} from "../../src/domain/decision/index.js";
import {
  REPLAY_SYMBOL,
  buildReplayBars,
  replayAccount,
  replayBarsBySymbol,
  replayPositions,
} from "../fixtures/replay/fixtures.js";

class StubDecisionBrain implements BrainProvider {
  readonly providerName = "mock" as const;
  lastInput?: BrainInput;

  constructor(
    private readonly structured: JsonValue,
    private readonly options: { throwOnGenerate?: boolean } = {},
  ) {}

  async generate(input: BrainInput): Promise<BrainOutput> {
    this.lastInput = input;
    if (this.options.throwOnGenerate) {
      throw new Error("model down");
    }
    return {
      requestId: input.requestId,
      provider: this.providerName,
      model: "mock-decider",
      taskType: input.taskType,
      generatedAt: "2026-06-19T07:30:00.000Z",
      summary: "ok",
      structured: this.structured,
      citations: [],
      confidence: 0.5,
      proposals: [],
    };
  }
}

function experienceReport(coverageThroughDate: string | null): SoftExperienceReport {
  return softExperienceReportSchema.parse({
    schemaVersion: 1,
    startDate: "2026-06-01",
    endDate: "2026-06-09",
    horizonTradingDays: 1,
    returnThreshold: 0,
    decisionsAnalyzed: 10,
    scoredStances: 6,
    coverageThroughDate,
    advisoryOnly: true,
    generatedBy: "soft-experience-distiller",
    lessons: [
      {
        regime: { trend: "uptrend", rangeBucket: "near_high", bias: "reduce" },
        sampleSize: 6,
        hits: 0,
        hitRate: 0,
        avgForwardReturn: 0.03,
        verdict: "unfavorable",
        advice: "逼近高位减配历史表现差，建议复核。",
      },
    ],
  });
}

async function snapshot(): Promise<PointInTimeSnapshot> {
  const reader = new AsOfMarketReader({
    historyProvider: new FixtureHistoryProvider(replayBarsBySymbol()),
  });
  return buildReplaySnapshot({
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
}

describe("ModelReplayDecider", () => {
  it("maps the model's stance into a model-generated decision", async () => {
    const brain = new StubDecisionBrain({
      stances: [{ symbol: REPLAY_SYMBOL, bias: "increase", confidence: 0.7, rationale: "测试加配" }],
    });
    const decision = await new ModelReplayDecider(brain).decide(await snapshot());

    expect(decision.generatedBy).toBe("model-replay-decider");
    expect(decision.stances).toHaveLength(1);
    expect(decision.stances[0]!.bias).toBe("increase");
    expect(decision.stances[0]!.confidence).toBe(0.7);
    expect(decision.stances[0]!.rationale).toBe("测试加配");
    // basis is grounded in the snapshot, NOT the model.
    expect(decision.stances[0]!.basis.technicalAsOfDate).toBe("2026-06-19");
  });

  it("SAFETY: the model cannot escalate — executable/reviewRequired are hard-wired", async () => {
    const brain = new StubDecisionBrain({
      stances: [{ symbol: REPLAY_SYMBOL, bias: "reduce" }],
      executable: true, // malicious / buggy model output — must be ignored
      reviewRequired: false,
    });
    const decision = await new ModelReplayDecider(brain).decide(await snapshot());

    expect(decision.executable).toBe(false);
    expect(decision.reviewRequired).toBe(true);
    expect(decision.stances[0]!.bias).toBe("reduce");
  });

  it("falls back to hold for an omitted symbol", async () => {
    const brain = new StubDecisionBrain({ stances: [{ symbol: "999999", bias: "increase" }] });
    const decision = await new ModelReplayDecider(brain).decide(await snapshot());

    expect(decision.stances[0]!.bias).toBe("hold");
    expect(decision.stances[0]!.rationale).toContain("模型未给出");
  });

  it("falls back to hold on malformed structured output", async () => {
    const brain = new StubDecisionBrain({ garbage: true });
    const decision = await new ModelReplayDecider(brain).decide(await snapshot());
    expect(decision.stances[0]!.bias).toBe("hold");
  });

  it("never crashes the replay on a model failure (all hold)", async () => {
    const brain = new StubDecisionBrain({}, { throwOnGenerate: true });
    const decision = await new ModelReplayDecider(brain).decide(await snapshot());
    expect(decision.stances[0]!.bias).toBe("hold");
    expect(decision.executable).toBe(false);
  });

  it("feeds the model ONLY the as-of snapshot context (future-blind)", async () => {
    const brain = new StubDecisionBrain({ stances: [{ symbol: REPLAY_SYMBOL, bias: "hold" }] });
    const snap = await snapshot();
    await new ModelReplayDecider(brain).decide(snap);

    expect(brain.lastInput).toBeDefined();
    const context = brain.lastInput!.context as Record<string, unknown>;
    expect(context.asOf).toBe(snap.asOfTime);
    expect(context.asOfDate).toBe(snap.asOfDate);
    expect(context.snapshot).toEqual(snap.brainContext);
    // The fixture has bars dated after the snapshot — none of them are in what the model saw.
    expect(buildReplayBars().some((bar) => bar.tradeDate > snap.asOfDate)).toBe(true);
    expect(JSON.stringify(context)).not.toContain("2026-06-22");
  });

  it("includes prior soft experience as a hint when it clears the temporal fence", async () => {
    const brain = new StubDecisionBrain({ stances: [{ symbol: REPLAY_SYMBOL, bias: "hold" }] });
    // Coverage 2026-06-10 is strictly before the snapshot's asOfDate (2026-06-19) -> usable.
    const experience = experienceReport("2026-06-10");
    await new ModelReplayDecider(brain, { experience }).decide(await snapshot());

    const prompt = brain.lastInput!.prompt;
    expect(prompt).toContain("历史软经验");
    expect(prompt).toContain("减配命中率"); // the fixture regime is uptrend·near_high
  });

  it("FENCE: omits experience whose coverage is not strictly before asOfDate", async () => {
    const snap = await snapshot();

    // (a) coverage AFTER the decision date (overlapping future) -> omit
    const future = new StubDecisionBrain({ stances: [{ symbol: REPLAY_SYMBOL, bias: "hold" }] });
    await new ModelReplayDecider(future, { experience: experienceReport("2026-06-22") }).decide(snap);
    expect(future.lastInput!.prompt).not.toContain("历史软经验");

    // (b) coverage EXACTLY on the decision date -> still omit (must be strictly before)
    const boundary = new StubDecisionBrain({ stances: [{ symbol: REPLAY_SYMBOL, bias: "hold" }] });
    await new ModelReplayDecider(boundary, { experience: experienceReport("2026-06-19") }).decide(snap);
    expect(boundary.lastInput!.prompt).not.toContain("历史软经验");
  });

  it("omits experience that scored nothing (null coverage)", async () => {
    const brain = new StubDecisionBrain({ stances: [{ symbol: REPLAY_SYMBOL, bias: "hold" }] });
    await new ModelReplayDecider(brain, { experience: experienceReport(null) }).decide(await snapshot());
    expect(brain.lastInput!.prompt).not.toContain("历史软经验");
  });

  it("still returns a normal non-executable decision when experience is supplied", async () => {
    const brain = new StubDecisionBrain({ stances: [{ symbol: REPLAY_SYMBOL, bias: "reduce" }] });
    const decision = await new ModelReplayDecider(brain, {
      experience: experienceReport("2026-06-10"),
    }).decide(await snapshot());
    expect(decision.executable).toBe(false);
    expect(decision.stances[0]!.bias).toBe("reduce");
  });

  it("works through the scoring seam, tagging the scorecard's decisions as model-generated", async () => {
    const brain = new StubDecisionBrain({ stances: [{ symbol: REPLAY_SYMBOL, bias: "increase" }] });
    const result = await scoreReplaySnapshots({
      snapshots: [await snapshot()],
      decider: new ModelReplayDecider(brain),
      forwardReader: new ForwardOutcomeReader(new FixtureHistoryProvider(replayBarsBySymbol())),
      startDate: "2026-06-19",
      endDate: "2026-06-19",
      horizonTradingDays: 1,
      returnThreshold: 0,
    });
    expect(result.scored[0]!.generatedBy).toBe("model-replay-decider");
    expect(result.scored[0]!.executable).toBe(false);
  });
});
