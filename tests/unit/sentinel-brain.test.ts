import { describe, expect, it } from "vitest";
import {
  analyzeMarketAlert,
  cerebellumEventToNotificationEvent,
  enrichSentinelNotification,
} from "../../src/app/index.js";
import { cerebellumEventSchema } from "../../src/domain/cerebellum/index.js";
import { positionSchema, type Position } from "../../src/domain/portfolio/index.js";
import type {
  BrainInput,
  BrainOutput,
  BrainProvider,
} from "../../src/domain/brain/index.js";

const now = "2026-06-21T02:30:00.000Z";

class StubBrain implements BrainProvider {
  readonly providerName = "mock" as const;
  lastPrompt = "";

  async generate(input: BrainInput): Promise<BrainOutput> {
    this.lastPrompt = input.prompt;
    return {
      requestId: input.requestId,
      provider: "mock",
      model: "mock-brain-v1",
      taskType: input.taskType,
      generatedAt: now,
      summary: "建议立即减仓 50%，已跌破成本止损线。",
      structured: {},
      citations: [],
      confidence: 0.7,
      proposals: [],
    };
  }
}

function makeEvent() {
  return cerebellumEventSchema.parse({
    eventId: "evt-1",
    eventType: "position_stop_loss",
    severity: "critical",
    symbol: "000636",
    market: "SZSE",
    name: "风华高科",
    occurredAt: now,
    message: "风华高科触及成本止损线",
    source: "market_sentinel",
    wakeBrain: true,
    cooldownKey: "000636-stop",
    currentPrice: 68.2,
    previousPrice: 70,
    changePct: -0.025,
    threshold: 0.08,
  });
}

function makePosition(): Position {
  return positionSchema.parse({
    accountId: "paper-main",
    symbol: "000636",
    market: "SZSE",
    name: "风华高科",
    quantity: 200,
    availableQuantity: 200,
    todayBuyQuantity: 0,
    frozenQuantity: 0,
    costPrice: 74,
    currency: "CNY",
    openedAt: now,
    updatedAt: now,
  });
}

describe("analyzeMarketAlert", () => {
  it("wakes the brain with the event facts + held position and returns its judgement", async () => {
    const brain = new StubBrain();
    const analysis = await analyzeMarketAlert(
      { event: makeEvent(), position: makePosition() },
      { brainProvider: brain },
    );

    expect(analysis).toBe("建议立即减仓 50%，已跌破成本止损线。");
    expect(brain.lastPrompt).toContain("唤醒规则：");
    expect(brain.lastPrompt).toContain("操作指令：");
    expect(brain.lastPrompt).toContain("1. ");
    expect(brain.lastPrompt).toContain("触及成本止损线");
    expect(brain.lastPrompt).toContain("成本 74");
  });
});

describe("enrichSentinelNotification", () => {
  it("flags the summary and puts the AI take in recommendedAction", () => {
    const base = cerebellumEventToNotificationEvent(makeEvent());
    const enriched = enrichSentinelNotification(base, "跌破止损，建议人工减仓。");

    expect(enriched.summary.startsWith("🔴")).toBe(true);
    expect(enriched.recommendedAction).toContain("AI研判：");
    expect(enriched.recommendedAction).toContain("跌破止损");
    expect((enriched.metadata as { brainAnalyzed?: boolean }).brainAnalyzed).toBe(true);
  });

  it("returns the base notification unchanged when analysis is empty", () => {
    const base = cerebellumEventToNotificationEvent(makeEvent());
    expect(enrichSentinelNotification(base, "   ")).toEqual(base);
  });
});
