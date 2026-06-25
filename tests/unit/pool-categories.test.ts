import { describe, expect, it } from "vitest";
import {
  categorizeUniverse,
  poolByBucket,
  renderPoolOverview,
  type PoolBucket,
} from "../../src/domain/market/index.js";
import type { UniverseStock } from "../../src/domain/market/index.js";

function stock(partial: Partial<UniverseStock> & Pick<UniverseStock, "symbol" | "name">): UniverseStock {
  return {
    market: partial.symbol.startsWith("6") ? "SSE" : "SZSE",
    latestPrice: 10,
    changePct: 0,
    turnoverRate: 5,
    volume: 1000,
    amount: 1e8,
    marketCap: 1e10,
    ...partial,
  };
}

/** Find which bucket a symbol landed in. */
function bucketOf(entries: ReturnType<typeof categorizeUniverse>, symbol: string): PoolBucket | undefined {
  return entries.find((entry) => entry.stock.symbol === symbol)?.bucket;
}

describe("categorizeUniverse", () => {
  it("assigns each stock one primary bucket by priority (position > limit_up > limit_down > change_top > amount_top)", () => {
    const universe = [
      stock({ symbol: "600000", name: "浦发银行", changePct: 1.2, amount: 9e9 }), // biggest 成交额
      stock({ symbol: "600519", name: "贵州茅台", changePct: 3.1, amount: 8e9 }), // high change + high amount
      stock({ symbol: "600036", name: "招商银行", changePct: 10.01, amount: 5e9 }), // 涨停
      stock({ symbol: "601398", name: "工商银行", changePct: -10.0, amount: 3e9 }), // 跌停
      stock({ symbol: "600030", name: "中信证券", changePct: 6.5, amount: 1e9 }), // 涨幅榜
    ];

    const entries = categorizeUniverse(universe, {
      heldSymbols: ["600000"],
      changeTopTarget: 5,
      amountTopTarget: 5,
    });

    // 600000 is held → position, even though it has the biggest 成交额.
    expect(bucketOf(entries, "600000")).toBe("position");
    // 涨停/跌停 win over change/amount ranking.
    expect(bucketOf(entries, "600036")).toBe("limit_up");
    expect(bucketOf(entries, "601398")).toBe("limit_down");
    // 600519 qualifies for both change_top and amount_top → change_top wins (higher priority).
    expect(bucketOf(entries, "600519")).toBe("change_top");
    expect(bucketOf(entries, "600030")).toBe("change_top");
  });

  it("never assigns a stock to two buckets and is reproducible", () => {
    const universe = Array.from({ length: 50 }, (_, index) =>
      stock({
        symbol: `60${String(index).padStart(4, "0")}`,
        name: `股票${index}`,
        changePct: index % 7,
        amount: (50 - index) * 1e8,
      }),
    );
    const a = categorizeUniverse(universe, { maxTotal: 40 });
    const b = categorizeUniverse(universe, { maxTotal: 40 });

    const symbols = a.map((entry) => entry.stock.symbol);
    expect(new Set(symbols).size).toBe(symbols.length); // no duplicates
    expect(a).toEqual(b); // deterministic
    expect(a.length).toBeLessThanOrEqual(40);
  });

  it("keeps held positions even when they are absent from the universe and over the cap", () => {
    const universe = Array.from({ length: 120 }, (_, index) =>
      stock({ symbol: `60${String(index).padStart(4, "0")}`, name: `名${index}`, amount: (200 - index) * 1e8 }),
    );
    const entries = categorizeUniverse(universe, {
      heldSymbols: ["000001", "600999"], // 000001 not in the universe at all
      heldNames: { "000001": "平安银行" },
      maxTotal: 100,
    });

    expect(entries.length).toBe(100);
    expect(bucketOf(entries, "000001")).toBe("position");
    expect(entries.find((entry) => entry.stock.symbol === "000001")?.stock.name).toBe("平安银行");
    const positions = poolByBucket(entries).get("position") ?? [];
    expect(positions.map((entry) => entry.stock.symbol).sort()).toEqual(["000001", "600999"]);
  });

  it("tags 昨日涨停/跌停 from prior-day symbols even when the stock is calm today", () => {
    const universe = [
      stock({ symbol: "600100", name: "连板候选", changePct: 1.2, amount: 3e8 }), // calm today, was 涨停 yesterday
      stock({ symbol: "600200", name: "反弹候选", changePct: -0.5, amount: 2e8 }), // was 跌停 yesterday
      stock({ symbol: "600300", name: "今日涨停", changePct: 10.0, amount: 5e8 }),
      stock({ symbol: "600400", name: "普通", changePct: 0.3, amount: 9e9 }),
    ];
    const entries = categorizeUniverse(universe, {
      yesterdayLimitUpSymbols: ["600100", "600300"], // 600300 is limit_up TODAY → today wins
      yesterdayLimitDownSymbols: ["600200"],
    });

    expect(bucketOf(entries, "600100")).toBe("yesterday_limit_up");
    expect(bucketOf(entries, "600200")).toBe("yesterday_limit_down");
    // 600300 was 昨日涨停 but is 涨停 again today → the more salient today bucket wins.
    expect(bucketOf(entries, "600300")).toBe("limit_up");
  });

  it("picks one 龙头 per hot sector (≥2 strong names), skipping names already on a limit board", () => {
    const universe = [
      // 半导体: 3 strong names → hot. Leader = highest 成交额 unassigned (600001).
      stock({ symbol: "600001", name: "半导体龙头", sector: "半导体", changePct: 6, amount: 9e9 }),
      stock({ symbol: "600002", name: "半导体涨停", sector: "半导体", changePct: 10, amount: 5e9 }), // → limit_up
      stock({ symbol: "600003", name: "半导体三", sector: "半导体", changePct: 7, amount: 3e9 }),
      // 银行: only 1 strong → NOT hot.
      stock({ symbol: "600010", name: "银行甲", sector: "银行", changePct: 6, amount: 8e9 }),
      stock({ symbol: "600011", name: "银行乙", sector: "银行", changePct: 0.5, amount: 7e9 }),
    ];
    const entries = categorizeUniverse(universe, { changeTopTarget: 0, amountTopTarget: 0 });

    expect(bucketOf(entries, "600002")).toBe("limit_up"); // limit wins over sector-leader
    expect(bucketOf(entries, "600001")).toBe("hot_sector_leader");
    // 银行 isn't hot → its names are not sector leaders.
    expect(bucketOf(entries, "600010")).not.toBe("hot_sector_leader");
  });

  it("produces no 热门板块龙头 when the universe carries no sector data (graceful degradation)", () => {
    const universe = [
      stock({ symbol: "600001", name: "甲", changePct: 9, amount: 9e9 }),
      stock({ symbol: "600002", name: "乙", changePct: 8, amount: 8e9 }),
    ];
    const entries = categorizeUniverse(universe);
    expect(entries.some((entry) => entry.bucket === "hot_sector_leader")).toBe(false);
  });

  it("excludes ST names, non-main-board (688/300), and unpriced halts", () => {
    const universe = [
      stock({ symbol: "600001", name: "ST康美", changePct: 9 }),
      stock({ symbol: "688981", name: "中芯国际", changePct: 9 }), // STAR board
      stock({ symbol: "300750", name: "宁德时代", changePct: 9 }), // ChiNext
      stock({ symbol: "600002", name: "停牌股", latestPrice: 0 }),
      stock({ symbol: "600003", name: "正常股", changePct: 4, amount: 2e8 }),
    ];
    const entries = categorizeUniverse(universe);
    const symbols = entries.map((entry) => entry.stock.symbol);
    expect(symbols).toEqual(["600003"]);
  });
});

describe("renderPoolOverview", () => {
  it("renders 层级1 counts + 层级2 named picks with 涨跌幅, filler counted only", () => {
    const universe = [
      stock({ symbol: "600036", name: "招商银行", changePct: 10.01, amount: 5e9 }), // 涨停
      stock({ symbol: "601398", name: "工商银行", changePct: -10.0, amount: 3e9 }), // 跌停
      stock({ symbol: "600030", name: "中信证券", changePct: 6.5, amount: 1e9 }), // 涨幅榜
      stock({ symbol: "600000", name: "浦发银行", changePct: 0.2, amount: 9e9 }), // 成交额(filler)
      stock({ symbol: "600519", name: "贵州茅台", changePct: 0.1, amount: 8e9 }), // 持仓
    ];
    // changeTopTarget:1 so only the top gainer is 涨幅榜; 600000 falls through to the filler.
    const entries = categorizeUniverse(universe, { heldSymbols: ["600519"], changeTopTarget: 1 });
    const overview = renderPoolOverview(entries);

    expect(overview).toContain("观察池 5 只");
    expect(overview).toContain("涨停1");
    expect(overview).toContain("持仓股1");
    // 层级2: named WITH code (anti-hallucination) + 涨跌幅 for informative buckets
    expect(overview).toContain("招商银行(600036 +10.01%)");
    expect(overview).toContain("中信证券(600030 +6.50%)");
    expect(overview).toContain("工商银行(601398 -10.00%)");
    // amount_top is the filler → counted in 层级1 but not named in 层级2
    expect(overview).toContain("成交额榜1");
    expect(overview).not.toContain("浦发银行");
  });

  it("returns empty string for an empty pool", () => {
    expect(renderPoolOverview([])).toBe("");
  });
});
