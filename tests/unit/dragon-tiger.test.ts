import { describe, expect, it } from "vitest";
import {
  dragonTigerEntrySchema,
  renderDragonTigerSummary,
  summarizeDragonTiger,
  type DragonTigerEntry,
} from "../../src/domain/market/index.js";

function entry(partial: Partial<DragonTigerEntry> & Pick<DragonTigerEntry, "symbol" | "name" | "netBuyAmount">): DragonTigerEntry {
  return dragonTigerEntrySchema.parse({
    tradeDate: "2026-06-25",
    market: partial.symbol.startsWith("6") ? "SSE" : "SZSE",
    changePct: 0,
    reasons: [],
    ...partial,
  });
}

describe("summarizeDragonTiger", () => {
  it("filters main-board non-ST and splits into 净买入/净卖出 ranks", () => {
    const entries = [
      entry({ symbol: "600584", name: "长电科技", changePct: 10, netBuyAmount: 4_111_744_166 }),
      entry({ symbol: "600667", name: "太极实业", changePct: 10, netBuyAmount: 721_721_252 }),
      entry({ symbol: "600172", name: "黄河旋风", changePct: 6.84, netBuyAmount: -165_448_573 }),
      entry({ symbol: "600719", name: "大连热电", changePct: -9.99, netBuyAmount: -24_288_358 }),
      entry({ symbol: "000004", name: "国华退", netBuyAmount: 999_999 }), // ST/退 → filtered
      entry({ symbol: "301013", name: "利和兴", netBuyAmount: 888_888 }), // 创业板 → filtered
    ];
    const summary = summarizeDragonTiger(entries, { topN: 3 });

    expect(summary.count).toBe(4); // ST + 创业板 dropped
    expect(summary.topNetBuy.map((e) => e.symbol)).toEqual(["600584", "600667"]); // desc, positives only
    // most-negative first
    expect(summary.topNetSell.map((e) => e.symbol)).toEqual(["600172", "600719"]);
  });

  it("renders a 盘后 summary with 净买/净卖 in 亿, empty when nothing qualifies", () => {
    const summary = summarizeDragonTiger([
      entry({ symbol: "600584", name: "长电科技", changePct: 10, netBuyAmount: 4_111_744_166 }),
    ]);
    const rendered = renderDragonTigerSummary(summary);
    expect(rendered).toContain("龙虎榜");
    expect(rendered).toContain("长电科技(600584 +10.00% 净买+41.12亿");

    expect(renderDragonTigerSummary(summarizeDragonTiger([]))).toBe("");
  });
});
