import { describe, expect, it } from "vitest";
import { computeSectorHeat, renderSectorHeat } from "../../src/domain/market/index.js";
import type { UniverseStock } from "../../src/domain/market/index.js";

function stock(partial: Partial<UniverseStock> & Pick<UniverseStock, "symbol" | "name">): UniverseStock {
  return {
    market: partial.symbol.startsWith("6") ? "SSE" : "SZSE",
    latestPrice: 10,
    changePct: 0,
    amount: 1e8,
    ...partial,
  };
}

describe("computeSectorHeat", () => {
  it("aggregates by sector, ranks 领涨/领跌 by mean changePct, honors the member floor", () => {
    const universe = [
      stock({ symbol: "600001", name: "半导体甲", sector: "半导体", changePct: 8, amount: 2e9 }),
      stock({ symbol: "600002", name: "半导体乙", sector: "半导体", changePct: 10, amount: 1e9 }), // 涨停
      stock({ symbol: "600003", name: "半导体丙", sector: "半导体", changePct: 6 }),
      stock({ symbol: "600010", name: "银行甲", sector: "银行", changePct: -2 }),
      stock({ symbol: "600011", name: "银行乙", sector: "银行", changePct: -1 }),
      stock({ symbol: "600012", name: "银行丙", sector: "银行", changePct: 0 }),
      stock({ symbol: "600020", name: "孤儿股", sector: "稀有", changePct: 9 }), // only 1 member → dropped
    ];
    const summary = computeSectorHeat(universe, { minMembers: 3, topN: 5 });

    expect(summary.sectorCount).toBe(2); // 稀有 dropped (1 member)
    expect(summary.topGainers[0]?.sector).toBe("半导体");
    expect(summary.topGainers[0]?.avgChangePct).toBeCloseTo(8, 5); // (8+10+6)/3
    expect(summary.topGainers[0]?.limitUpCount).toBe(1); // 600002 涨停
    expect(summary.topLosers[0]?.sector).toBe("银行");

    const rendered = renderSectorHeat(summary);
    expect(rendered).toContain("领涨：半导体+8.00%");
    expect(rendered).toContain("领跌：银行-1.00%");
    expect(rendered).toContain("·1涨停");
  });

  it("returns empty summary/string when no rows carry sector (graceful degradation)", () => {
    const universe = [stock({ symbol: "600001", name: "甲", changePct: 5 })];
    const summary = computeSectorHeat(universe);
    expect(summary.sectorCount).toBe(0);
    expect(renderSectorHeat(summary)).toBe("");
  });
});
