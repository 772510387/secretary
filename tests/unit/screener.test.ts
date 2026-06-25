import { describe, expect, it } from "vitest";
import {
  inferAshareBoard,
  isMainBoardSymbol,
  isLikelySTName,
  screenUniverse,
  universeStockSchema,
  type UniverseStock,
} from "../../src/domain/market/index.js";

function universe(): UniverseStock[] {
  return [
    { symbol: "600519", market: "SSE", name: "贵州茅台", latestPrice: 1600, changePct: 0.2, turnoverRate: 0.3, amount: 4e9, marketCap: 2e12 },
    { symbol: "000636", market: "SZSE", name: "风华高科", latestPrice: 74, changePct: 0.73, turnoverRate: 3.2, amount: 8e8, marketCap: 8e10 },
    { symbol: "000001", market: "SZSE", name: "平安银行", latestPrice: 11, changePct: -0.5, turnoverRate: 0.8, amount: 6e8, marketCap: 2e11 },
    { symbol: "600000", market: "SSE", name: "浦发银行", latestPrice: 10, changePct: 1.2, turnoverRate: 0.5, amount: 5e8, marketCap: 3e11 },
    { symbol: "300750", market: "SZSE", name: "宁德时代", latestPrice: 200, changePct: 2.5, turnoverRate: 1.1, amount: 5e9, marketCap: 9e11 },
    { symbol: "688981", market: "SSE", name: "中芯国际", latestPrice: 50, changePct: 3.0, turnoverRate: 2.0, amount: 3e9, marketCap: 4e11 },
    { symbol: "000620", market: "SZSE", name: "*ST新华", latestPrice: 2, changePct: 5, turnoverRate: 10, amount: 1e8, marketCap: 1e9 },
    { symbol: "600002", market: "SSE", name: "停牌股", changePct: undefined, amount: undefined },
  ].map((stock) => universeStockSchema.parse(stock));
}

describe("board helpers", () => {
  it("classifies boards and main-board membership", () => {
    expect(inferAshareBoard("600519")).toBe("sse_main");
    expect(inferAshareBoard("000001")).toBe("szse_main");
    expect(inferAshareBoard("300750")).toBe("chinext");
    expect(inferAshareBoard("688981")).toBe("star");
    expect(isMainBoardSymbol("600519")).toBe(true);
    expect(isMainBoardSymbol("300750")).toBe(false);
    expect(isMainBoardSymbol("688981")).toBe(false);
    expect(isLikelySTName("*ST新华")).toBe(true);
    expect(isLikelySTName("风华高科")).toBe(false);
  });
});

describe("screenUniverse", () => {
  it("defaults to main-board, non-ST, priced stocks ranked by amount desc", () => {
    const result = screenUniverse(universe(), {});
    // drops 创业板(300750), 科创(688981), *ST(000620), 停牌(600002 no price)
    expect(result.map((s) => s.symbol)).toEqual(["600519", "000636", "000001", "600000"]);
  });

  it("honors limit (top-N)", () => {
    expect(screenUniverse(universe(), { limit: 2 }).map((s) => s.symbol)).toEqual(["600519", "000636"]);
  });

  it("ranks by changePct when asked", () => {
    const result = screenUniverse(universe(), { sortBy: "changePct" });
    expect(result[0]?.symbol).toBe("600000"); // +1.2% is the highest among main-board priced
    expect(result.map((s) => s.symbol)).toEqual(["600000", "000636", "600519", "000001"]);
  });

  it("applies a liquidity floor (minAmount)", () => {
    const result = screenUniverse(universe(), { minAmount: 1e9 });
    expect(result.map((s) => s.symbol)).toEqual(["600519"]);
  });

  it("can include other boards and ST when explicitly disabled", () => {
    const result = screenUniverse(universe(), { mainBoardOnly: false, excludeST: false, requirePrice: false, limit: 100 });
    expect(result.map((s) => s.symbol)).toContain("300750");
    expect(result.map((s) => s.symbol)).toContain("000620");
  });

  it("is deterministic (stable symbol tie-break)", () => {
    const first = screenUniverse(universe(), { sortBy: "amount" }).map((s) => s.symbol);
    const second = screenUniverse(universe(), { sortBy: "amount" }).map((s) => s.symbol);
    expect(first).toEqual(second);
  });
});
