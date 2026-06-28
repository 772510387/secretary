import { describe, expect, it } from "vitest";
import {
  buildBrainOperationNotification,
  buildDefaultSystemPrompt,
  buildPaperAgentTools,
  runBrainAgentTurn,
  type PaperAgentToolDeps,
  type PaperPortfolioView,
} from "../../src/app/index.js";
import { shouldPushToExternalChannels } from "../../src/domain/notification/index.js";
import type { AgentToolStep, ToolCallingProvider } from "../../src/domain/brain/index.js";

const now = "2026-06-24T01:00:00.000Z";

const portfolio: PaperPortfolioView = {
  accountId: "paper-1",
  availableCash: 100_000,
  totalCash: 100_000,
  totalAssets: 100_000,
  totalPositionMarketValue: 0,
  totalUnrealizedPnl: 0,
  investedRatio: 0,
  positions: [],
  pricesAvailable: true,
};

function deps(): PaperAgentToolDeps {
  return {
    loadPortfolio: () => portfolio,
    getQuote: () => ({ symbol: "600519", price: 1700 }),
    executePaperOrder: () => ({ status: "filled", quantity: 100, limitPrice: 1700 }),
  };
}

function scriptedProvider(steps: AgentToolStep[]): ToolCallingProvider {
  let i = 0;
  return {
    providerName: "mock",
    async chatWithTools(): Promise<AgentToolStep> {
      const step = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      return step;
    },
  };
}

describe("runBrainAgentTurn", () => {
  it("reads, places a paper trade, and surfaces the executed operation", async () => {
    const provider = scriptedProvider([
      { content: "", toolCalls: [{ id: "c1", name: "get_quote", arguments: '{"symbol":"600519"}' }] },
      { content: "", toolCalls: [{ id: "c2", name: "paper_buy", arguments: '{"symbol":"600519","reason":"放量突破"}' }] },
      { content: "已按计划建仓茅台 100 股。", toolCalls: [] },
    ]);

    const result = await runBrainAgentTurn({
      question: "看看茅台，合适就买点",
      provider,
      tools: buildPaperAgentTools(deps()),
      now,
    });

    expect(result.answer).toContain("已按计划建仓");
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]!.summary).toContain("买入 600519");
    expect(result.stoppedReason).toBe("completed");
  });

  it("rejects an empty question", async () => {
    await expect(
      runBrainAgentTurn({ question: "   ", provider: scriptedProvider([]), tools: buildPaperAgentTools(deps()) }),
    ).rejects.toThrow(/must not be empty/);
  });
});

describe("buildDefaultSystemPrompt", () => {
  it("injects the current Beijing date", () => {
    const prompt = buildDefaultSystemPrompt(now);
    expect(prompt).toContain("2026-06-24");
    expect(prompt).toContain("模拟盘");
  });

  it("instructs operation-review follow-ups to use the evidence tool", () => {
    const prompt = buildDefaultSystemPrompt(now);
    expect(prompt).toContain("get_operation_review");
    expect(prompt).toContain("为什么买卖");
    expect(prompt).toContain("用户纠正操作事实");
  });
});

describe("buildBrainOperationNotification", () => {
  it("builds a pushable executed-operation notification from operations", () => {
    const event = buildBrainOperationNotification({
      operations: [{ kind: "paper_buy", mutated: true, summary: "买入 600519 100股@1700：已成交（逻辑：放量突破）" }],
      answer: "已建仓。",
      accountId: "paper-1",
      now,
    });

    expect(event).not.toBeNull();
    expect(event!.metadata.executed).toBe(true);
    expect(event!.summary).toContain("买入 600519");
    // The push gate must classify this as an operation worth an external push.
    expect(shouldPushToExternalChannels(event!)).toBe(true);
  });

  it("returns null when no operation actually happened", () => {
    expect(buildBrainOperationNotification({ operations: [], now })).toBeNull();
  });
});
