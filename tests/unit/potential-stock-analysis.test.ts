import { describe, expect, it } from "vitest";
import {
  analyzePotentialStocks,
  candidatesFromShortlist,
  renderPotentialStockAnalysisReport,
  watchlistEntryToPotentialStockCandidate,
  type PotentialStockCandidate,
} from "../../src/app/index.js";
import type { BrainInput, BrainOutput, BrainProvider } from "../../src/domain/brain/index.js";
import type { WatchlistEntry } from "../../src/domain/market/index.js";
import type { JsonValue } from "../../src/domain/shared/index.js";

const NOW = "2026-06-26T01:00:00.000Z";

class StubBrain implements BrainProvider {
  readonly providerName = "mock" as const;
  calls: BrainInput[] = [];

  constructor(private readonly structured: JsonValue) {}

  async generate(input: BrainInput): Promise<BrainOutput> {
    this.calls.push(input);
    return {
      requestId: input.requestId,
      provider: "mock",
      model: "mock",
      taskType: input.taskType,
      generatedAt: NOW,
      summary: "ok",
      structured: this.structured,
      citations: [],
      confidence: 0.8,
      proposals: [],
    };
  }
}

const candidate: PotentialStockCandidate = {
  symbol: "600519",
  market: "SSE",
  name: "贵州茅台",
  priority: "high",
  rationale: "白酒龙头，主力净流入 3 亿，日线上升趋势。",
  rank: 1,
  latestPrice: 100,
  changePct: 3.2,
  mainNetInflow: 300_000_000,
  isHeld: false,
};

describe("potential stock analysis", () => {
  it("uses model structured output and renders the display-depth report", async () => {
    const brain = new StubBrain({
      summary: "精选 1 支高优先级潜力股，等待回调确认。",
      recommendations: {
        firstChoice: ["贵州茅台 98 元附近，白酒龙头"],
        secondChoice: [],
        defensive: [],
      },
      stocks: [
        {
          symbol: "600519",
          market: "SSE",
          name: "贵州茅台",
          priority: "high",
          currentLabel: "+3.20%",
          coreLogic: "白酒龙头，资金回流。",
          reasons: ["主力净流入 3 亿", "日线上升趋势"],
          buyAdvice: {
            idealBuyPoint: "98 元附近",
            stopLoss: "90 元",
            target: "115 元",
            position: "10%，待风控复核",
            priority: "高",
          },
          risks: ["消费板块退潮", "估值波动"],
          trackingPoints: ["能否守住 100 元"],
        },
      ],
      followUps: [{ symbol: "600519", name: "贵州茅台", point: "能否守住 100 元" }],
      safetyNotes: ["只读分析，未下单。"],
    });

    const result = await analyzePotentialStocks(
      { candidates: [candidate], now: NOW, question: "潜力股深度分析" },
      { brainProvider: brain },
    );
    const rendered = renderPotentialStockAnalysisReport(result.report);

    expect(result.report.degraded).toBe(false);
    expect(rendered).toContain("潜力股池");
    expect(rendered).toContain("核心逻辑：白酒龙头，资金回流。");
    expect(rendered).toContain("买点：98 元附近");
    expect(rendered).toContain("安全边界：只读分析，未下单。");
    expect(brain.calls[0]!.prompt).toContain("严禁引入池外代码");
  });

  it("falls back to deterministic full-depth content when model output is unusable", async () => {
    const result = await analyzePotentialStocks(
      { candidates: [candidate], now: NOW },
      { brainProvider: new StubBrain({ nope: true }) },
    );

    expect(result.report.degraded).toBe(true);
    expect(result.report.stocks[0]!.coreLogic).toContain("白酒龙头");
    expect(result.report.stocks[0]!.buyAdvice.idealBuyPoint).toContain("95-98");
    expect(renderPotentialStockAnalysisReport(result.report)).toContain("未下单、未写账户");
  });

  it("converts watchlist entries and shortlist picks into enriched analysis candidates", () => {
    const entry: WatchlistEntry = {
      symbol: "600519",
      market: "SSE",
      name: "贵州茅台",
      priority: "high",
      reason: "成交额榜 · 主力净流入 3 亿",
      source: "test",
      updatedAt: NOW,
      metadata: {
        rank: 2,
        latestPrice: 100,
        changePct: 3.2,
        bucketLabel: "成交额榜",
        mainNetInflow: 300_000_000,
      },
    };
    const detail = watchlistEntryToPotentialStockCandidate(entry);
    const candidates = candidatesFromShortlist({
      shortlist: [{ symbol: "600519", market: "SSE", name: "贵州茅台", rank: 1, rationale: "模型入选理由" }],
      details: [detail],
      prices: { "600519": 101 },
    });

    expect(candidates[0]).toMatchObject({
      symbol: "600519",
      latestPrice: 101,
      rank: 1,
      bucketLabel: "成交额榜",
      rationale: "模型入选理由",
    });
  });
});
