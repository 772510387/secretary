import { describe, expect, it } from "vitest";
import { runDataWarmupSelfCheck } from "../../src/app/index.js";
import { accountSchema, positionSchema, type Account, type Position } from "../../src/domain/portfolio/index.js";

const now = "2026-06-24T00:30:00.000Z";

function makeAccount(): Account {
  return accountSchema.parse({
    accountId: "paper-main",
    type: "paper",
    baseCurrency: "CNY",
    initialCash: 20000,
    cash: { available: 14688, frozen: 0 },
    status: "active",
    createdAt: now,
    updatedAt: now,
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
    costPrice: 56.68,
    latestPrice: 64.3,
    currency: "CNY",
    openedAt: now,
    updatedAt: now,
  });
}

describe("runDataWarmupSelfCheck (PRE-01)", () => {
  it("passes when the ledger is present and the pool is populated", () => {
    const check = runDataWarmupSelfCheck({
      account: makeAccount(),
      positions: [makePosition()],
      watchlistCount: 100,
    });
    expect(check.ok).toBe(true);
    expect(check.accountPresent).toBe(true);
    expect(check.positionsCount).toBe(1);
    expect(check.cashAvailable).toBe(14688);
    expect(check.totalCostBasis).toBe(11336);
    expect(check.notes).toHaveLength(0);
  });

  it("flags an empty pool and a missing account", () => {
    const emptyPool = runDataWarmupSelfCheck({ account: makeAccount(), positions: [], watchlistCount: 0 });
    expect(emptyPool.ok).toBe(false);
    expect(emptyPool.notes.join()).toContain("100支高关注池为空");

    const noAccount = runDataWarmupSelfCheck({ account: null, positions: [], watchlistCount: 0 });
    expect(noAccount.accountPresent).toBe(false);
    expect(noAccount.cashAvailable).toBeNull();
    expect(noAccount.notes.join()).toContain("账户缺失");
  });
});
