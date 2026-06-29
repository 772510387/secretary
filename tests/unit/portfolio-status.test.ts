import { describe, expect, it } from "vitest";
import {
  detectPortfolioStatusQuery,
  formatPortfolioStatus,
} from "../../src/app/portfolio-status.js";
import {
  accountSchema,
  positionSchema,
  type Account,
  type Position,
} from "../../src/domain/portfolio/index.js";

const now = "2026-06-24T01:00:00.000Z";

function makeAccount(available = 8800): Account {
  return accountSchema.parse({
    accountId: "paper-main",
    type: "paper",
    baseCurrency: "CNY",
    initialCash: 10000,
    cash: { available, frozen: 0 },
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

function makePosition(overrides: Partial<Parameters<typeof positionSchema.parse>[0]> = {}): Position {
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
    openedAt: now,
    updatedAt: now,
    ...overrides,
  });
}

describe("detectPortfolioStatusQuery", () => {
  it("matches plain status lookups", () => {
    expect(detectPortfolioStatusQuery("当前模拟盘信息是？")).toBe(true);
    expect(detectPortfolioStatusQuery("还有多少现金")).toBe(true);
    expect(detectPortfolioStatusQuery("现在仓位多少")).toBe(true);
    expect(detectPortfolioStatusQuery("持仓情况")).toBe(true);
  });

  it("does NOT match analysis / action / market questions (those need the model)", () => {
    expect(detectPortfolioStatusQuery("分析一下我的持仓")).toBe(false);
    expect(detectPortfolioStatusQuery("持仓要不要减仓")).toBe(false);
    expect(detectPortfolioStatusQuery("模拟本周一的操作")).toBe(false);
    expect(detectPortfolioStatusQuery("大盘怎么样")).toBe(false);
    expect(detectPortfolioStatusQuery("帮我清空模拟盘")).toBe(false);
  });
});

describe("formatPortfolioStatus", () => {
  it("renders totals and per-position pnl deterministically from stored prices", () => {
    const reply = formatPortfolioStatus({
      account: makeAccount(8800),
      positions: [makePosition()],
    });

    // market value 100*12 = 1200; cost 1000; pnl +200 (+20%); total = 8800 + 1200 = 10000.
    expect(reply).toContain("总资产 ¥10,000.00");
    expect(reply).toContain("可用现金 ¥8,800.00");
    expect(reply).toContain("持仓市值 ¥1,200.00");
    expect(reply).toContain("总浮动盈亏 ¥+200.00（+20.00%）");
    expect(reply).toContain("风华高科(000636)");
    expect(reply).toContain("盈亏¥+200.00(+20.00%)");
    expect(reply).toContain("模拟盘账本");
  });

  it("renders an empty account as 空仓", () => {
    const reply = formatPortfolioStatus({ account: makeAccount(10000), positions: [] });
    expect(reply).toContain("当前空仓（无持仓）。");
    expect(reply).toContain("总资产 ¥10,000.00");
  });

  it("marks holdings to market with fresh prices (fixes the 现价==成本 zero-pnl)", () => {
    // A simulated fill leaves latestPrice == cost; without a fresh quote the holding reads 0.
    const position = makePosition({
      symbol: "000021",
      name: "深科技",
      costPrice: 53.51,
      latestPrice: 53.51,
      quantity: 100,
      availableQuantity: 0,
    });

    const stale = formatPortfolioStatus({ account: makeAccount(625), positions: [position] });
    expect(stale).toContain("盈亏¥+0.00(+0.00%)"); // the reported bug
    expect(stale).toContain("可能仍是买入价");

    const fresh = formatPortfolioStatus({
      account: makeAccount(625),
      positions: [position],
      prices: { "000021": 58.86 }, // today's close (+10% vs 53.51 cost)
    });
    expect(fresh).toContain("现价58.86");
    expect(fresh).toContain("盈亏¥+535.00(+10.00%)");
    expect(fresh).toContain("最新实时/收盘报价");
  });
});
