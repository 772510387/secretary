import { describe, expect, it } from "vitest";
import {
  PortfolioCalculationError,
  accountSchema,
  calculateAverageCostAfterBuy,
  calculateCashSummary,
  calculateCostBasis,
  calculateMarketValue,
  calculatePortfolioValuation,
  calculatePositionValuation,
  calculateRealizedCost,
  calculateSellableQuantity,
  calculateT1AvailableQuantity,
  calculateUnrealizedPnl,
  calculateUnrealizedPnlRatio,
  positionSchema,
  roundMoney,
  roundPrice,
  roundRatio,
  type Account,
  type Position,
} from "../../src/domain/portfolio/index.js";

describe("portfolio rounding", () => {
  it("uses a consistent precision policy for money, price, and ratio", () => {
    expect(roundMoney(1000.105)).toBe(1000.11);
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundPrice(11.02505)).toBe(11.0251);
    expect(roundRatio(1 / 3)).toBe(0.333333);
  });
});

describe("cash calculation", () => {
  it("calculates available, frozen, and total cash", () => {
    const account = makeAccount({
      cash: {
        available: 1000.105,
        frozen: 2.335,
      },
    });

    expect(calculateCashSummary(account)).toEqual({
      available: 1000.11,
      frozen: 2.34,
      total: 1002.45,
    });
  });
});

describe("position valuation", () => {
  it("calculates cost basis, market value, unrealized pnl, and pnl ratio", () => {
    const position = makePosition({
      quantity: 200,
      availableQuantity: 200,
      todayBuyQuantity: 0,
      frozenQuantity: 0,
      costPrice: 56.68,
      latestPrice: 64.3,
    });

    expect(calculateCostBasis(position)).toBe(11336);
    expect(calculateMarketValue(position)).toBe(12860);
    expect(calculateUnrealizedPnl(position)).toBe(1524);
    expect(calculateUnrealizedPnlRatio(position)).toBe(0.134439);
    expect(calculatePositionValuation(position)).toMatchObject({
      symbol: "000636",
      quantity: 200,
      sellableQuantity: 200,
      costPrice: 56.68,
      latestPrice: 64.3,
      costBasis: 11336,
      marketValue: 12860,
      unrealizedPnl: 1524,
      unrealizedPnlRatio: 0.134439,
    });
  });

  it("allows an external latest price override without mutating the position", () => {
    const position = makePosition({ quantity: 100, costPrice: 10, latestPrice: 9 });

    expect(calculatePositionValuation(position, { latestPrice: 12 })).toMatchObject({
      latestPrice: 12,
      costBasis: 1000,
      marketValue: 1200,
      unrealizedPnl: 200,
      unrealizedPnlRatio: 0.2,
    });
    expect(position.latestPrice).toBe(9);
  });
});

describe("T+1 and sellable quantity", () => {
  it("blocks today's buy quantity under T+1", () => {
    const position = makePosition({
      quantity: 200,
      availableQuantity: 170,
      todayBuyQuantity: 100,
      frozenQuantity: 30,
    });

    expect(calculateT1AvailableQuantity(position)).toBe(70);
    expect(calculateSellableQuantity(position)).toBe(70);
  });

  it("uses the lower value between stored available quantity and computed T+1 quantity", () => {
    const position = makePosition({
      quantity: 200,
      availableQuantity: 50,
      todayBuyQuantity: 100,
      frozenQuantity: 30,
    });

    expect(calculateT1AvailableQuantity(position)).toBe(70);
    expect(calculateSellableQuantity(position)).toBe(50);
  });

  it("can disable T+1 while still respecting frozen quantity and stored availability", () => {
    const position = makePosition({
      quantity: 200,
      availableQuantity: 170,
      todayBuyQuantity: 100,
      frozenQuantity: 30,
    });

    expect(calculateT1AvailableQuantity(position, { t1Enabled: false })).toBe(170);
    expect(calculateSellableQuantity(position, { t1Enabled: false })).toBe(170);
  });
});

describe("cost calculations", () => {
  it("calculates weighted average cost after a buy including fees", () => {
    expect(
      calculateAverageCostAfterBuy({
        existingQuantity: 100,
        existingCostPrice: 10,
        buyQuantity: 100,
        buyPrice: 12,
        buyFees: 5,
      }),
    ).toBe(11.025);

    expect(
      calculateAverageCostAfterBuy({
        existingQuantity: 0,
        existingCostPrice: 0,
        buyQuantity: 100,
        buyPrice: 10,
        buyFees: 5,
      }),
    ).toBe(10.05);
  });

  it("calculates realized cost and rejects invalid cost inputs", () => {
    expect(calculateRealizedCost(100, 56.68)).toBe(5668);

    expect(() =>
      calculateAverageCostAfterBuy({
        existingQuantity: 100,
        existingCostPrice: 10,
        buyQuantity: 0,
        buyPrice: 12,
      }),
    ).toThrow(PortfolioCalculationError);
    expect(() => calculateRealizedCost(0, 10)).toThrow(PortfolioCalculationError);
  });
});

describe("portfolio valuation", () => {
  it("calculates total assets, position market value, pnl, and ratios", () => {
    const account = makeAccount({
      cash: {
        available: 800,
        frozen: 200,
      },
    });
    const positions = [
      makePosition({
        symbol: "000636",
        name: "风华高科",
        quantity: 100,
        availableQuantity: 100,
        costPrice: 10,
        latestPrice: 12,
      }),
      makePosition({
        symbol: "601187",
        market: "SSE",
        name: "厦门银行",
        quantity: 100,
        availableQuantity: 100,
        costPrice: 5,
        latestPrice: 4,
      }),
    ];

    const valuation = calculatePortfolioValuation(account, positions);

    expect(valuation.cash).toEqual({
      available: 800,
      frozen: 200,
      total: 1000,
    });
    expect(valuation.totalPositionMarketValue).toBe(1600);
    expect(valuation.totalCostBasis).toBe(1500);
    expect(valuation.totalUnrealizedPnl).toBe(100);
    expect(valuation.totalAssets).toBe(2600);
    expect(valuation.investedRatio).toBe(0.615385);
    expect(valuation.positions.map((position) => position.positionRatio)).toEqual([
      0.461538,
      0.153846,
    ]);
  });

  it("uses external prices in portfolio valuation", () => {
    const account = makeAccount({
      cash: {
        available: 1000,
        frozen: 0,
      },
    });
    const position = makePosition({
      quantity: 100,
      availableQuantity: 100,
      costPrice: 10,
      latestPrice: 9,
    });

    const valuation = calculatePortfolioValuation(account, [position], {
      prices: {
        "000636": 12,
      },
    });

    expect(valuation.positions[0]?.latestPrice).toBe(12);
    expect(valuation.totalPositionMarketValue).toBe(1200);
    expect(valuation.totalAssets).toBe(2200);
  });
});

function makeAccount(overrides: Partial<Account> = {}): Account {
  return accountSchema.parse({
    accountId: "paper-main",
    type: "paper",
    baseCurrency: "CNY",
    initialCash: 20000,
    cash: {
      available: 20000,
      frozen: 0,
    },
    status: "active",
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...overrides,
  });
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return positionSchema.parse({
    accountId: "paper-main",
    symbol: "000636",
    market: "SZSE",
    name: "风华高科",
    quantity: 100,
    availableQuantity: 100,
    todayBuyQuantity: 0,
    frozenQuantity: 0,
    costPrice: 10,
    latestPrice: 12,
    currency: "CNY",
    openedAt: "2026-06-12T01:30:00.000Z",
    updatedAt: "2026-06-12T07:00:00.000Z",
    ...overrides,
  });
}
