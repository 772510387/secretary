import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config/index.js";
import { buildFunnelExecutionConstraints } from "../../src/app/index.js";
import type { Account, Position } from "../../src/domain/portfolio/index.js";
import type { PlanWatchlistEntry } from "../../src/domain/plan/index.js";

const CONFIG: AppConfig = (() => {
  const config = loadConfig();
  return {
    ...config,
    trading: {
      ...config.trading,
      mode: "paper",
      mainBoardOnly: true,
      lotSize: 100,
      t1Enabled: true,
    },
    risk: {
      ...config.risk,
      maxSinglePositionRatio: 0.4,
    },
  };
})();

const ACCOUNT: Account = {
  accountId: "paper-main",
  type: "paper",
  status: "active",
  baseCurrency: "CNY",
  initialCash: 20000,
  cash: { available: 20000, frozen: 0 },
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z",
};

const WATCHLIST: PlanWatchlistEntry[] = [
  { symbol: "603986", market: "SSE", name: "兆易创新", rank: 1 },
  { symbol: "600522", market: "SSE", name: "中天科技", rank: 2 },
  { symbol: "000725", market: "SZSE", name: "京东方A", rank: 3 },
  { symbol: "300750", market: "SZSE", name: "宁德时代", rank: 4 },
];

function position(input: Partial<Position> & Pick<Position, "symbol" | "market" | "name">): Position {
  return {
    accountId: "paper-main",
    quantity: 600,
    availableQuantity: 600,
    todayBuyQuantity: 0,
    frozenQuantity: 0,
    costPrice: 10,
    latestPrice: 10,
    currency: "CNY",
    openedAt: "2026-06-19T01:30:00.000Z",
    updatedAt: "2026-06-19T07:00:00.000Z",
    ...input,
  };
}

describe("buildFunnelExecutionConstraints", () => {
  it("pre-filters BUY candidates by board, quote, cash, lot size and single-position cap", () => {
    const constraints = buildFunnelExecutionConstraints({
      account: ACCOUNT,
      positions: [],
      watchlist100: WATCHLIST,
      prices: {
        "603986": 100, // 100 shares would cost 10000, above the 8000 single-position cap.
        "600522": 56.55,
        "000725": 6.55,
        "300750": 200, // ChiNext is not tradable under mainBoardOnly.
      },
      config: CONFIG,
      maxBuyOrders: 2,
      maxSellOrders: 2,
    });

    expect(constraints.buyCandidates?.map((candidate) => candidate.symbol)).toEqual(["600522", "000725"]);
    expect(constraints.buyCandidates?.[0]).toMatchObject({
      symbol: "600522",
      side: "BUY",
      maxQuantity: 100,
      latestPrice: 56.55,
    });
    expect(constraints.buyCandidates?.[1]).toMatchObject({
      symbol: "000725",
      side: "BUY",
      maxQuantity: 1200,
      latestPrice: 6.55,
    });
  });

  it("pre-filters SELL candidates by actual T+1 sellable quantity", () => {
    const constraints = buildFunnelExecutionConstraints({
      account: ACCOUNT,
      positions: [
        position({ symbol: "000725", market: "SZSE", name: "京东方A", quantity: 1200, availableQuantity: 0, todayBuyQuantity: 1200 }),
        position({ symbol: "600522", market: "SSE", name: "中天科技", quantity: 100, availableQuantity: 100, todayBuyQuantity: 0, latestPrice: 56.55 }),
      ],
      watchlist100: WATCHLIST,
      prices: { "000725": 6.55, "600522": 56.55 },
      config: CONFIG,
    });

    expect(constraints.sellCandidates?.map((candidate) => candidate.symbol)).toEqual(["600522"]);
    expect(constraints.sellCandidates?.[0]).toMatchObject({
      side: "SELL",
      maxQuantity: 100,
      latestPrice: 56.55,
    });
  });
});
