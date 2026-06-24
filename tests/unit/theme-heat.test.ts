import { describe, expect, it } from "vitest";
import { universeStockSchema, type UniverseStock } from "../../src/domain/market/screener.js";
import {
  classifyLimitState,
  computeThemeHeat,
  ThemeHeatError,
  type ComputeThemeHeatOptions,
} from "../../src/domain/market/theme-heat.js";

/**
 * Build a validated UniverseStock so fixtures stay honest against the real
 * schema. changePct is a PERCENT (9.97 = +9.97%), confirmed by the schema doc.
 */
function stock(partial: Partial<UniverseStock> & Pick<UniverseStock, "symbol" | "name">): UniverseStock {
  return universeStockSchema.parse({
    market: partial.symbol.startsWith("6") ? "SSE" : "SZSE",
    latestPrice: 10,
    changePct: 0,
    turnoverRate: 1,
    volume: 1_000_000,
    amount: 1e8,
    marketCap: 1e10,
    ...partial,
  });
}

describe("classifyLimitState (PRE-04)", () => {
  it("flags main-board limit-up/down at the ±10% band and normal otherwise", () => {
    expect(classifyLimitState("600000", 9.97)).toBe("limit_up");
    expect(classifyLimitState("000636", -9.9)).toBe("limit_down");
    expect(classifyLimitState("600000", 3.2)).toBe("normal");
  });

  it("uses the wider ±20% band for 科创/创业板", () => {
    expect(classifyLimitState("300750", 9.97)).toBe("normal"); // not a limit on 创业板
    expect(classifyLimitState("300750", 19.8)).toBe("limit_up");
    expect(classifyLimitState("688111", -19.7)).toBe("limit_down");
  });

  it("returns unknown when changePct is absent (never guesses)", () => {
    expect(classifyLimitState("600000", undefined)).toBe("unknown");
  });
});

describe("computeThemeHeat — limit-up counting per board threshold", () => {
  it("counts a +9.9% main-board name as 涨停 but not a +9.0% one", () => {
    const universe = [
      stock({ symbol: "600000", name: "主板涨停", changePct: 9.9 }),
      stock({ symbol: "600001", name: "主板未涨停", changePct: 9.0 }),
    ];
    const summary = computeThemeHeat(universe);
    expect(summary.limitUpCount).toBe(1);
  });

  it("counts a (hypothetical) +12% main-board name — anything >= the 主板 cap counts", () => {
    const universe = [stock({ symbol: "000001", name: "主板异常", changePct: 12 })];
    expect(computeThemeHeat(universe).limitUpCount).toBe(1);
  });

  it("does NOT count a +12% ChiNext (300xxx) name — it needs the 20% threshold", () => {
    const universe = [stock({ symbol: "300750", name: "创业板未涨停", changePct: 12 })];
    expect(computeThemeHeat(universe).limitUpCount).toBe(0);
  });

  it("counts a +19.9% ChiNext (300xxx) name as 涨停 at the 20% threshold", () => {
    const universe = [stock({ symbol: "300750", name: "创业板涨停", changePct: 19.9 })];
    expect(computeThemeHeat(universe).limitUpCount).toBe(1);
  });

  it("counts a +19.9% STAR (688xxx) name as 涨停 at the 20% threshold", () => {
    const universe = [stock({ symbol: "688981", name: "科创板涨停", changePct: 19.9 })];
    expect(computeThemeHeat(universe).limitUpCount).toBe(1);
  });

  it("counts 跌停 symmetrically per board", () => {
    const universe = [
      stock({ symbol: "600000", name: "主板跌停", changePct: -9.9 }),
      stock({ symbol: "300750", name: "创业板未跌停", changePct: -12 }), // -12% < 20% cap -> not 跌停
      stock({ symbol: "300751", name: "创业板跌停", changePct: -19.9 }),
    ];
    const summary = computeThemeHeat(universe);
    expect(summary.limitDownCount).toBe(2);
  });
});

describe("computeThemeHeat — advancers / decliners split", () => {
  it("splits up / down and treats 平盘 (0%) as neither", () => {
    const universe = [
      stock({ symbol: "600000", name: "涨", changePct: 3.2 }),
      stock({ symbol: "600001", name: "涨2", changePct: 0.1 }),
      stock({ symbol: "600002", name: "跌", changePct: -1.5 }),
      stock({ symbol: "600003", name: "平", changePct: 0 }),
    ];
    const summary = computeThemeHeat(universe);
    expect(summary.advancers).toBe(2);
    expect(summary.decliners).toBe(1);
  });
});

describe("computeThemeHeat — topGainers / topByAmount ordering + capping", () => {
  it("orders topGainers by changePct desc and caps at topN", () => {
    const universe = [
      stock({ symbol: "600000", name: "A", changePct: 1 }),
      stock({ symbol: "600001", name: "B", changePct: 9 }),
      stock({ symbol: "600002", name: "C", changePct: 5 }),
      stock({ symbol: "600003", name: "D", changePct: 7 }),
    ];
    const summary = computeThemeHeat(universe, { topN: 2 });
    expect(summary.topGainers.map((g) => g.symbol)).toEqual(["600001", "600003"]);
    expect(summary.topGainers).toHaveLength(2);
  });

  it("orders topByAmount by 成交额 desc and caps at topN", () => {
    const universe = [
      stock({ symbol: "600000", name: "A", amount: 1e8 }),
      stock({ symbol: "600001", name: "B", amount: 9e9 }),
      stock({ symbol: "600002", name: "C", amount: 5e9 }),
    ];
    const summary = computeThemeHeat(universe, { topN: 2 });
    expect(summary.topByAmount.map((g) => g.symbol)).toEqual(["600001", "600002"]);
    expect(summary.topByAmount).toHaveLength(2);
  });

  it("breaks ties on symbol so ranking is deterministic", () => {
    const universe = [
      stock({ symbol: "600002", name: "A", changePct: 5 }),
      stock({ symbol: "600001", name: "B", changePct: 5 }),
    ];
    const summary = computeThemeHeat(universe);
    expect(summary.topGainers.map((g) => g.symbol)).toEqual(["600001", "600002"]);
  });
});

describe("computeThemeHeat — degradation", () => {
  it("empty universe → degraded with notes and heatScore 0, no throw", () => {
    const summary = computeThemeHeat([]);
    expect(summary.degraded).toBe(true);
    expect(summary.heatScore).toBe(0);
    expect(summary.universeSize).toBe(0);
    expect(summary.limitUpCount).toBeNull();
    expect(summary.limitDownCount).toBeNull();
    expect(summary.advancers).toBeNull();
    expect(summary.decliners).toBeNull();
    expect(summary.topGainers).toEqual([]);
    expect(summary.topByAmount).toEqual([]);
    expect(summary.notes.length).toBeGreaterThan(0);
  });

  it("missing changePct across universe → limitUpCount null + note, never fabricated 0", () => {
    const universe = [
      stock({ symbol: "600000", name: "无涨跌", changePct: undefined }),
      stock({ symbol: "600001", name: "无涨跌2", changePct: undefined }),
    ];
    const summary = computeThemeHeat(universe);
    expect(summary.limitUpCount).toBeNull();
    expect(summary.limitDownCount).toBeNull();
    expect(summary.advancers).toBeNull();
    expect(summary.decliners).toBeNull();
    expect(summary.degraded).toBe(true);
    expect(summary.notes.some((note) => note.includes("changePct"))).toBe(true);
    // amount still present → topByAmount still computed and not degraded for that reason.
    expect(summary.topByAmount).toHaveLength(2);
  });

  it("partial changePct coverage → counts over available rows + a coverage note", () => {
    const universe = [
      stock({ symbol: "600000", name: "有数据涨停", changePct: 9.9 }),
      stock({ symbol: "600001", name: "缺数据", changePct: undefined }),
    ];
    const summary = computeThemeHeat(universe);
    expect(summary.limitUpCount).toBe(1);
    expect(summary.advancers).toBe(1);
    expect(summary.degraded).toBe(true);
    expect(summary.notes.some((note) => note.includes("缺少 changePct"))).toBe(true);
  });
});

describe("computeThemeHeat — options & misc", () => {
  it("stamps asOf from injected now and stays pure (null when omitted)", () => {
    const opts: ComputeThemeHeatOptions = { now: "2026-06-23T01:30:00.000Z" };
    expect(computeThemeHeat([stock({ symbol: "600000", name: "X" })], opts).asOf).toBe(
      "2026-06-23T01:30:00.000Z",
    );
    expect(computeThemeHeat([stock({ symbol: "600000", name: "X" })]).asOf).toBeNull();
  });

  it("is deterministic: same input → identical output", () => {
    const universe = [
      stock({ symbol: "600000", name: "A", changePct: 9.9, amount: 5e9 }),
      stock({ symbol: "300750", name: "B", changePct: 19.9, amount: 9e9 }),
    ];
    expect(computeThemeHeat(universe, { now: "t" })).toEqual(computeThemeHeat(universe, { now: "t" }));
  });

  it("produces a meaningful 0..100 heatScore for a hot tape", () => {
    const universe = [
      stock({ symbol: "600000", name: "涨停", changePct: 9.9, amount: 9e9 }),
      stock({ symbol: "600001", name: "涨", changePct: 4, amount: 1e8 }),
      stock({ symbol: "600002", name: "涨", changePct: 2, amount: 1e8 }),
    ];
    const summary = computeThemeHeat(universe);
    expect(summary.heatScore).toBeGreaterThan(0);
    expect(summary.heatScore).toBeLessThanOrEqual(100);
  });

  it("throws ThemeHeatError on a non-positive / non-integer topN", () => {
    expect(() => computeThemeHeat([], { topN: 0 })).toThrow(ThemeHeatError);
    expect(() => computeThemeHeat([], { topN: 1.5 })).toThrow(ThemeHeatError);
  });
});
