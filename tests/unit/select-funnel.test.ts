import { describe, expect, it } from "vitest";
import { selectFunnelStage } from "../../src/app/index.js";
import type { BrainInput, BrainOutput, BrainProvider } from "../../src/domain/brain/index.js";
import type { JsonValue } from "../../src/domain/shared/index.js";
import type { PlanWatchlistEntry } from "../../src/domain/plan/index.js";

const ASOF = "2026-06-22T01:00:00.000Z";

class StubBrain implements BrainProvider {
  readonly providerName = "mock" as const;
  constructor(private readonly structured: JsonValue) {}
  async generate(input: BrainInput): Promise<BrainOutput> {
    return {
      requestId: input.requestId,
      provider: this.providerName,
      model: "mock",
      taskType: input.taskType,
      generatedAt: ASOF,
      summary: "",
      structured: this.structured,
      citations: [],
      confidence: 0.5,
      proposals: [],
    };
  }
}

const POOL: PlanWatchlistEntry[] = [
  { symbol: "000001", market: "SZSE", name: "平安银行", rank: 1 },
  { symbol: "600519", market: "SSE", name: "贵州茅台", rank: 2 },
  { symbol: "000002", market: "SZSE", name: "万科A", rank: 3 },
];

function run(structured: JsonValue, holdings: { symbol: string; market: "SSE" | "SZSE"; name: string }[] = [], shortlistSize?: number) {
  return selectFunnelStage(
    { accountId: "paper-main", asOf: ASOF, watchlist100: POOL, holdings, shortlistSize },
    { brainProvider: new StubBrain(structured) },
  );
}

describe("selectFunnelStage", () => {
  it("maps model picks (∩ pool) into a shortlist + review-required proposals", async () => {
    const result = await run({
      shortlist: [{ symbol: "000001", rationale: "好" }, { symbol: "600519", rationale: "强" }],
      orders: [{ symbol: "000001", side: "BUY", rationale: "买" }],
    });
    expect(result.degraded).toBe(false);
    expect(result.shortlist10.map((s) => s.symbol)).toEqual(["000001", "600519"]);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.side).toBe("BUY");
    expect(result.proposals[0]!.status).toBe("pending_review");
    expect(result.proposals[0]!.executionGuard.executable).toBe(false);
    expect(result.proposals[0]!.quantity).toBeUndefined(); // sizing is deterministic at execution, not the model's
  });

  it("drops out-of-pool shortlist + BUY, and SELL of a non-held symbol", async () => {
    const result = await run({
      shortlist: [{ symbol: "999999", rationale: "幽灵" }, { symbol: "000001", rationale: "好" }],
      orders: [
        { symbol: "999999", side: "BUY", rationale: "池外" },
        { symbol: "000002", side: "SELL", rationale: "卖没持有的" },
      ],
    });
    expect(result.shortlist10.map((s) => s.symbol)).toEqual(["000001"]);
    expect(result.proposals).toHaveLength(0);
  });

  it("allows SELL only for a held symbol", async () => {
    const result = await run(
      { shortlist: [], orders: [{ symbol: "000002", side: "SELL", rationale: "减" }] },
      [{ symbol: "000002", market: "SZSE", name: "万科A" }],
    );
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.side).toBe("SELL");
  });

  it("keeps orders inside backend-sized executable candidates and carries quantity/price", async () => {
    const result = await selectFunnelStage(
      {
        accountId: "paper-main",
        asOf: ASOF,
        watchlist100: POOL,
        holdings: [{ symbol: "000002", market: "SZSE", name: "万科A" }],
        executionConstraints: {
          buyCandidates: [
            {
              side: "BUY",
              symbol: "000001",
              market: "SZSE",
              name: "平安银行",
              latestPrice: 13,
              maxQuantity: 600,
              estimatedAmount: 7800,
            },
          ],
          sellCandidates: [],
          maxBuyOrders: 1,
          maxSellOrders: 1,
        },
      },
      {
        brainProvider: new StubBrain({
          shortlist: [{ symbol: "000001", rationale: "好" }],
          orders: [
            { symbol: "000001", side: "BUY", rationale: "可成交" },
            { symbol: "600519", side: "BUY", rationale: "候选外" },
            { symbol: "000002", side: "SELL", rationale: "T+1不可卖" },
          ],
        }),
      },
    );

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      side: "BUY",
      symbol: "000001",
      quantity: 600,
      limitPrice: 13,
    });
  });

  it("falls back to top-N shortlist on unusable model output (degraded)", async () => {
    const result = await run({ garbage: true }, [], 2);
    expect(result.degraded).toBe(true);
    expect(result.shortlist10.map((s) => s.symbol)).toEqual(["000001", "600519"]);
    expect(result.proposals).toHaveLength(0);
  });
});
