import { describe, expect, it } from "vitest";
import { fulfilTurnPlan } from "../../src/app/index.js";
import { turnPlanNeedsContext } from "../../src/domain/brain/index.js";
import { accountSchema, type Account } from "../../src/domain/portfolio/index.js";
import type { BrainInput, BrainOutput, BrainProvider } from "../../src/domain/brain/index.js";
import type { JsonValue } from "../../src/domain/shared/index.js";
import type { PlanWatchlistEntry } from "../../src/domain/plan/index.js";

const now = "2026-06-26T01:00:00.000Z";

class FunnelStubBrain implements BrainProvider {
  readonly providerName = "mock" as const;
  constructor(private readonly structured: JsonValue) {}
  async generate(input: BrainInput): Promise<BrainOutput> {
    return {
      requestId: input.requestId,
      provider: "mock",
      model: "mock",
      taskType: input.taskType,
      generatedAt: now,
      summary: "",
      structured: this.structured,
      citations: [],
      confidence: 0.5,
      proposals: [],
    };
  }
}

function account(): Account {
  return accountSchema.parse({
    accountId: "paper-main",
    type: "paper",
    baseCurrency: "CNY",
    initialCash: 20000,
    cash: { available: 20000, frozen: 0 },
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

const POOL: PlanWatchlistEntry[] = [
  { symbol: "600519", market: "SSE", name: "贵州茅台", rank: 1 },
  { symbol: "600036", market: "SSE", name: "招商银行", rank: 2 },
];

describe("pick_stocks (read-only 选股) routing + fulfilment", () => {
  it("needs context (so the bridge loads the 100池)", () => {
    expect(turnPlanNeedsContext("pick_stocks")).toBe(true);
  });

  it("renders a deep potential-stock analysis from the funnel selection, writes nothing, no confirmation", async () => {
    const brain = new FunnelStubBrain({
      shortlist: [
        { symbol: "600519", rationale: "白酒龙头趋势好" },
        { symbol: "600036", rationale: "银行估值低" },
      ],
      orders: [{ symbol: "600519", side: "BUY", rationale: "回调到位" }],
    });
    const result = await fulfilTurnPlan(
      { intent: "pick_stocks", requiresConfirmation: false },
      { message: "帮我选几支潜力股", account: account(), positions: [], watchlist: POOL, now },
      { brainProvider: brain },
    );

    expect(result.intent).toBe("pick_stocks");
    expect(result.requiresConfirmation).toBe(false);
    expect(result.action).toBeUndefined(); // no state-changing action
    expect(result.reply).toContain("潜力股池");
    expect(result.reply).toContain("核心逻辑");
    expect(result.reply).toContain("贵州茅台(600519)");
    // 待买/待卖 now carry the per-stock reason, not just the name.
    expect(result.reply).toContain("待买候选（仅待复核，未下单）：");
    expect(result.reply).toContain("贵州茅台(600519)｜回调到位");
    expect(result.reply).toContain("未下单、未写账户");
  });

  it("returns a friendly reply when the 100池 is empty (no crash)", async () => {
    const result = await fulfilTurnPlan(
      { intent: "pick_stocks", requiresConfirmation: false },
      { message: "选股", account: account(), positions: [], watchlist: [], now },
      { brainProvider: new FunnelStubBrain({ shortlist: [], orders: [] }) },
    );
    expect(result.reply).toContain("观察池现在是空的");
    expect(result.requiresConfirmation).toBe(false);
  });

  it("requires a paper account before selecting", async () => {
    await expect(
      fulfilTurnPlan(
        { intent: "pick_stocks", requiresConfirmation: false },
        { message: "选股", watchlist: POOL, now },
        { brainProvider: new FunnelStubBrain({ shortlist: [], orders: [] }) },
      ),
    ).rejects.toThrow(/账户/);
  });
});
