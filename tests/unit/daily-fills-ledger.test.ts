import { describe, expect, it } from "vitest";
import { buildDailyFillsLedger } from "../../src/app/index.js";
import { tradeRecordSchema, type TradeRecord } from "../../src/domain/portfolio/index.js";

function makeTrade(overrides: Partial<TradeRecord> & Pick<TradeRecord, "side" | "tradeDate">): TradeRecord {
  return tradeRecordSchema.parse({
    tradeId: `trade-${overrides.side}-${overrides.tradeDate}-${overrides.symbol ?? "000636"}`,
    accountId: "paper-main",
    symbol: "000636",
    market: "SZSE",
    quantity: 100,
    price: 10,
    grossAmount: 1000,
    fees: 0,
    tax: 0,
    netAmount: 1000,
    currency: "CNY",
    tradedAt: `${overrides.tradeDate}T06:00:00.000Z`,
    source: "paper",
    ...overrides,
  });
}

describe("buildDailyFillsLedger (MEM-03)", () => {
  it("summarises the day's real fills and ignores other days", () => {
    const trades: TradeRecord[] = [
      makeTrade({ side: "BUY", tradeDate: "2026-06-24", symbol: "000636", netAmount: 1000 }),
      makeTrade({ side: "SELL", tradeDate: "2026-06-24", symbol: "600000", netAmount: 1500 }),
      makeTrade({ side: "BUY", tradeDate: "2026-06-23", symbol: "000636", netAmount: 999 }),
    ];

    const ledger = buildDailyFillsLedger(trades, "2026-06-24");
    expect(ledger.count).toBe(2);
    expect(ledger.buyCount).toBe(1);
    expect(ledger.sellCount).toBe(1);
    expect(ledger.buyAmount).toBe(1000);
    expect(ledger.sellAmount).toBe(1500);
    expect(ledger.rendered).toContain("今日成交账单");
    expect(ledger.rendered).toContain("BUY 000636");
    expect(ledger.rendered).not.toContain("999"); // the 06-23 fill is excluded
  });

  it("states 无成交 honestly when there were no fills", () => {
    const ledger = buildDailyFillsLedger([], "2026-06-24");
    expect(ledger.count).toBe(0);
    expect(ledger.rendered).toContain("无成交");
  });
});
