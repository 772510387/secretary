import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildTradingDayReviewFactPack,
  createTradingDayReview,
  createTradingDayReviewFromMemory,
} from "../../src/app/index.js";
import {
  accountSchema,
  positionSchema,
  tradeRecordSchema,
  type Account,
  type Position,
  type TradeRecord,
} from "../../src/domain/portfolio/index.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("trading-day review", () => {
  it("builds a grounded fact pack and markdown review from trades", () => {
    const review = createTradingDayReview({
      tradingDate: "2026-06-09",
      account: account(),
      positions: [position()],
      trades: sampleTrades(),
      previousSummary: { tradingDate: "2026-06-08", totalAssets: 100000, totalUnrealizedPnl: 0 },
      currentSummary: { tradingDate: "2026-06-09", totalAssets: 101055, totalUnrealizedPnl: -115 },
      proposalRationales: {
        "intent-buy-1": "小幅高开，建立底仓。",
        "intent-sell-1": "接近 5% 异动线，部分止盈。",
      },
      generatedAt: "2026-06-09T07:30:00.000Z",
    });

    expect(review.factPack.asset.pnlAmount).toBe(1055);
    expect(review.factPack.asset.realizedPnl).toBe(1170);
    expect(review.factPack.operationStats).toMatchObject({
      buyCount: 1,
      sellCount: 3,
      buyQuantity: 3000,
      sellQuantity: 2500,
    });
    expect(review.factPack.tradeTimeline[0]?.beijingTime).toBe("09:25");
    expect(review.markdown).toContain("# 2026-06-09 完整交易日复盘");
    expect(review.markdown).toContain("总盈亏：+¥1,055.00 (+1.05%)");
    expect(review.markdown).toContain("已实现盈亏：+¥570.00");
    expect(review.markdown).toContain("小幅高开，建立底仓");
    expect(review.validation.ok).toBe(true);
  });

  it("does not invent realized pnl when sell cost is unavailable", () => {
    const sellOnly = makeTrade({
      tradeId: "trade-sell-only",
      intentId: "intent-sell-only",
      side: "SELL",
      quantity: 100,
      price: 11,
      grossAmount: 1100,
      netAmount: 1100,
      tradedAt: "2026-06-09T02:00:00.000Z",
    });

    const fact = buildTradingDayReviewFactPack({
      tradingDate: "2026-06-09",
      account: account(),
      positions: [],
      trades: [sellOnly],
    });

    expect(fact.asset.realizedPnl).toBeNull();
    expect(fact.asset.realizedPnlUnknownQuantity).toBe(100);
    const review = createTradingDayReview({
      tradingDate: "2026-06-09",
      account: account(),
      positions: [],
      trades: [sellOnly],
    });
    expect(review.markdown).toContain("成本依据不足，未确认");
    expect(review.markdown).toContain("有 100 股卖出缺少可回溯成本");
  });

  it("reads memory, joins proposal rationale, and writes the markdown review", () => {
    const memoryDir = makeTempDir();
    mkdirSync(path.join(memoryDir, "portfolio", "snapshots"), { recursive: true });
    mkdirSync(path.join(memoryDir, "proposals", "2026-06-09"), { recursive: true });
    writeFileSync(path.join(memoryDir, "portfolio", "account.json"), `${JSON.stringify(account())}\n`);
    writeFileSync(path.join(memoryDir, "portfolio", "positions.json"), `${JSON.stringify([position()])}\n`);
    writeFileSync(
      path.join(memoryDir, "portfolio", "trades.jsonl"),
      sampleTrades().map((trade) => JSON.stringify(trade)).join("\n") + "\n",
    );
    writeFileSync(
      path.join(memoryDir, "portfolio", "daily-summary.jsonl"),
      [
        JSON.stringify({
          tradingDate: "2026-06-08",
          totalAssets: 100000,
          availableCash: 100000,
          investedRatio: 0,
          positionCount: 0,
          totalUnrealizedPnl: 0,
          generatedAt: "2026-06-08T07:30:00.000Z",
        }),
        JSON.stringify({
          tradingDate: "2026-06-09",
          totalAssets: 101055,
          availableCash: 94895,
          investedRatio: 0.060956,
          positionCount: 1,
          totalUnrealizedPnl: -115,
          generatedAt: "2026-06-09T07:30:00.000Z",
        }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      path.join(memoryDir, "proposals", "2026-06-09", "buy.json"),
      `${JSON.stringify({
        proposalId: "buy-1",
        rationale: "小幅高开，建立底仓。",
      })}\n`,
    );

    const review = createTradingDayReviewFromMemory({
      memoryDir,
      tradingDate: "2026-06-09",
      generatedAt: "2026-06-09T07:40:00.000Z",
      write: true,
    });

    expect(review.markdown).toContain("小幅高开，建立底仓");
    expect(review.write?.filePath).toBe(
      path.join(memoryDir, "reviews", "2026-06-09", "trading-day-review.md"),
    );
    expect(existsSync(review.write!.filePath)).toBe(true);
    expect(readFileSync(review.write!.filePath, "utf8")).toContain("完整交易日复盘");
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "trading-day-review-"));
  tempDirs.push(dir);
  return dir;
}

function account(): Account {
  return accountSchema.parse({
    accountId: "paper-main",
    type: "paper",
    baseCurrency: "CNY",
    initialCash: 100000,
    cash: { available: 94895, frozen: 0 },
    status: "active",
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-09T07:30:00.000Z",
  });
}

function position(): Position {
  return positionSchema.parse({
    accountId: "paper-main",
    symbol: "000636",
    market: "SZSE",
    name: "风华高科",
    quantity: 500,
    availableQuantity: 500,
    todayBuyQuantity: 0,
    frozenQuantity: 0,
    costPrice: 12.55,
    latestPrice: 12.32,
    currency: "CNY",
    openedAt: "2026-06-09T01:25:00.000Z",
    updatedAt: "2026-06-09T07:30:00.000Z",
  });
}

function sampleTrades(): TradeRecord[] {
  return [
    makeTrade({
      tradeId: "trade-buy-1",
      intentId: "intent-buy-1",
      side: "BUY",
      quantity: 3000,
      price: 12.55,
      grossAmount: 37650,
      netAmount: 37650,
      tradedAt: "2026-06-09T01:25:00.000Z",
    }),
    makeTrade({
      tradeId: "trade-sell-1",
      intentId: "intent-sell-1",
      side: "SELL",
      quantity: 1000,
      price: 13.12,
      grossAmount: 13120,
      netAmount: 13120,
      tradedAt: "2026-06-09T01:45:00.000Z",
    }),
    makeTrade({
      tradeId: "trade-sell-2",
      intentId: "intent-sell-2",
      side: "SELL",
      quantity: 1000,
      price: 13.25,
      grossAmount: 13250,
      netAmount: 13250,
      tradedAt: "2026-06-09T02:00:00.000Z",
      note: "突破 5% 后继续止盈。",
    }),
    makeTrade({
      tradeId: "trade-sell-3",
      intentId: "intent-sell-3",
      side: "SELL",
      quantity: 500,
      price: 12.35,
      grossAmount: 6175,
      netAmount: 6175,
      tradedAt: "2026-06-09T06:50:00.000Z",
      note: "尾盘降低风险。",
    }),
  ];
}

function makeTrade(
  overrides: Partial<TradeRecord> & Pick<TradeRecord, "tradeId" | "side" | "quantity" | "price" | "grossAmount" | "netAmount" | "tradedAt">,
): TradeRecord {
  return tradeRecordSchema.parse({
    accountId: "paper-main",
    symbol: "000636",
    market: "SZSE",
    fees: 0,
    tax: 0,
    currency: "CNY",
    tradeDate: "2026-06-09",
    source: "paper",
    ...overrides,
  });
}
