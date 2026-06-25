import { describe, expect, it } from "vitest";
import {
  EastmoneyBillboardProvider,
  BillboardProviderError,
  parseDragonTiger,
  type BillboardFetchResponse,
} from "../../src/infrastructure/providers/index.js";

// Trimmed from a real Eastmoney RPT_DAILYBILLBOARD_DETAILSNEW response (2026-06-25):
// 600172 appears on TWO 上榜原因 rows sharing one stock-level NET_BS_AMT (dedup target);
// 000004 (退/ST) and 301013 (创业板) are present so filtering can be exercised downstream.
const sample = JSON.stringify({
  result: {
    data: [
      { TRADE_DATE: "2026-06-25 00:00:00", SECURITY_CODE: "000004", SECURITY_NAME_ABBR: "国华退", MARKET: "SZ", CLOSE_PRICE: 0.26, CHANGE_RATE: -7.1429, TURNOVERRATE: 10.12, NET_BS_AMT: -346206.25, SUM_BUY_AMT: 791450, SUM_SELL_AMT: 1137656.25, ACCUM_AMOUNT: 3216449, EXPLANATION: "退市整理期" },
      { TRADE_DATE: "2026-06-25 00:00:00", SECURITY_CODE: "301013", SECURITY_NAME_ABBR: "利和兴", MARKET: "SZ", CLOSE_PRICE: 84.91, CHANGE_RATE: 13.2889, TURNOVERRATE: 29.26, NET_BS_AMT: 0, SUM_BUY_AMT: 1, SUM_SELL_AMT: 1, ACCUM_AMOUNT: 1, EXPLANATION: "严重异常" },
      { TRADE_DATE: "2026-06-25 00:00:00", SECURITY_CODE: "600172", SECURITY_NAME_ABBR: "黄河旋风", MARKET: "SH", CLOSE_PRICE: 18.27, CHANGE_RATE: 6.8421, TURNOVERRATE: 31.46, NET_BS_AMT: -165448573.49, SUM_BUY_AMT: 629740468.46, SUM_SELL_AMT: 795189041.95, ACCUM_AMOUNT: 6812273190, EXPLANATION: "日换手率达到20%的前五只证券" },
      { TRADE_DATE: "2026-06-25 00:00:00", SECURITY_CODE: "600172", SECURITY_NAME_ABBR: "黄河旋风", MARKET: "SH", CLOSE_PRICE: 18.27, CHANGE_RATE: 6.8421, TURNOVERRATE: 31.46, NET_BS_AMT: -165448573.49, SUM_BUY_AMT: 629740468.46, SUM_SELL_AMT: 795189041.95, ACCUM_AMOUNT: 6812273190, EXPLANATION: "日价格振幅达到15%的前五只证券" },
      { TRADE_DATE: "2026-06-25 00:00:00", SECURITY_CODE: "600584", SECURITY_NAME_ABBR: "长电科技", MARKET: "SH", CLOSE_PRICE: 104.17, CHANGE_RATE: 10, TURNOVERRATE: 6.69, NET_BS_AMT: 4111744166.96, SUM_BUY_AMT: 6299386613.36, SUM_SELL_AMT: 2187642446.4, ACCUM_AMOUNT: 36109394706, EXPLANATION: "连续三个交易日涨幅偏离值累计达到20%" },
      { TRADE_DATE: "2026-06-25 00:00:00", SECURITY_CODE: "600719", SECURITY_NAME_ABBR: "大连热电", MARKET: "SH", CLOSE_PRICE: 8.47, CHANGE_RATE: -9.9894, TURNOVERRATE: 12.29, NET_BS_AMT: -24288358.18, SUM_BUY_AMT: 38702635.1, SUM_SELL_AMT: 62990993.28, ACCUM_AMOUNT: 430567790, EXPLANATION: "日跌幅偏离值达到7%的前五只证券" },
    ],
    count: 6,
  },
  success: true,
  code: 0,
});

function ok(text: string): BillboardFetchResponse {
  return { ok: true, status: 200, text: async () => text };
}

describe("parseDragonTiger", () => {
  it("dedupes multi-reason rows into one entry per stock, collecting reasons", () => {
    const entries = parseDragonTiger(sample);
    // 600172's two rows collapse to one entry → 5 distinct stocks.
    expect(entries).toHaveLength(5);

    const huanghe = entries.find((e) => e.symbol === "600172");
    expect(huanghe?.market).toBe("SSE");
    expect(huanghe?.netBuyAmount).toBeCloseTo(-165448573.49, 2);
    expect(huanghe?.reasons).toHaveLength(2); // both 上榜原因 collected, NET not summed
    expect(huanghe?.tradeDate).toBe("2026-06-25");

    const changdian = entries.find((e) => e.symbol === "600584");
    expect(changdian).toMatchObject({ market: "SSE", changePct: 10, netBuyAmount: 4111744166.96 });
  });

  it("returns [] for an empty/non-trading-day board, throws on malformed JSON", () => {
    expect(parseDragonTiger(JSON.stringify({ result: { data: null }, success: true }))).toEqual([]);
    expect(() => parseDragonTiger("not json")).toThrow(BillboardProviderError);
  });
});

describe("EastmoneyBillboardProvider", () => {
  it("builds a date-filtered request and parses the board", async () => {
    let calledUrl = "";
    const provider = new EastmoneyBillboardProvider({
      fetchImpl: async (url) => {
        calledUrl = url;
        return ok(sample);
      },
    });
    const entries = await provider.getDragonTiger("2026-06-25");

    expect(calledUrl).toContain("RPT_DAILYBILLBOARD_DETAILSNEW");
    expect(calledUrl).toContain(encodeURIComponent("(TRADE_DATE='2026-06-25')"));
    expect(entries.map((e) => e.symbol).sort()).toEqual(["000004", "301013", "600172", "600584", "600719"]);
  });

  it("raises a clear error on HTTP failure", async () => {
    const provider = new EastmoneyBillboardProvider({
      maxRetries: 0,
      fetchImpl: async () => ({ ok: false, status: 503, statusText: "x", text: async () => "" }),
    });
    await expect(provider.getDragonTiger("2026-06-25")).rejects.toThrow(BillboardProviderError);
  });
});
