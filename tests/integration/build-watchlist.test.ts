import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWatchlistFromScreen,
  persistCategorizedPool,
  type UniverseSource,
} from "../../src/app/index.js";
import { universeStockSchema, type UniverseStock } from "../../src/domain/market/index.js";
import { WatchlistMemoryStore } from "../../src/infrastructure/storage/index.js";

const now = "2026-06-21T01:00:00.000Z";

function fakeProvider(): UniverseSource {
  const stocks: UniverseStock[] = [
    { symbol: "600519", market: "SSE", name: "贵州茅台", latestPrice: 1600, changePct: 0.2, turnoverRate: 0.3, amount: 4e9, marketCap: 2e12 },
    { symbol: "000636", market: "SZSE", name: "风华高科", latestPrice: 74, changePct: 0.73, turnoverRate: 3.2, amount: 8e8, marketCap: 8e10 },
    { symbol: "600000", market: "SSE", name: "浦发银行", latestPrice: 10, changePct: 1.2, turnoverRate: 0.5, amount: 5e8, marketCap: 3e11 },
    { symbol: "300750", market: "SZSE", name: "宁德时代", latestPrice: 200, changePct: 2.5, turnoverRate: 1.1, amount: 5e9, marketCap: 9e11 },
  ].map((stock) => universeStockSchema.parse(stock));
  return { getUniverse: async () => stocks };
}

describe("buildWatchlistFromScreen", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "secretary-wl-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("screens the universe to main-board top-N and persists a real watchlist", async () => {
    const store = new WatchlistMemoryStore({ memoryDir: dir, now: () => new Date(now) });
    const result = await buildWatchlistFromScreen({
      provider: fakeProvider(),
      writer: store,
      category: "watchlist_today",
      criteria: { limit: 3, sortBy: "amount" },
      mode: "replace",
      now,
    });

    expect(result.universeSize).toBe(4);
    // 300750 (创业板) is screened out; top-3 main-board by amount selected.
    expect(result.written).toBe(3);
    expect([...result.entries.map((entry) => entry.symbol)].sort()).toEqual(["000636", "600000", "600519"]);

    const persisted = store.readCategory("watchlist_today");
    expect(persisted.entries).toHaveLength(3);
    expect(persisted.entries.every((entry) => /^(600|000)/.test(entry.symbol))).toBe(true);
    // Snapshot order is by priority+symbol, but the screen rank is preserved in metadata.
    const maotai = persisted.entries.find((entry) => entry.symbol === "600519");
    expect(maotai?.metadata.rank).toBe(1); // highest amount
    expect(maotai?.metadata.limitState).toBe("normal"); // PRE-04: deterministic 涨停/跌停 signal
    expect(maotai?.source).toBe("screener");
    const fenghua = persisted.entries.find((entry) => entry.symbol === "000636");
    expect(fenghua?.metadata.rank).toBe(2);
  });

  it("builds a separate potential-stocks pool by a different ranking", async () => {
    const store = new WatchlistMemoryStore({ memoryDir: dir, now: () => new Date(now) });
    const result = await buildWatchlistFromScreen({
      provider: fakeProvider(),
      writer: store,
      category: "potential_stocks",
      criteria: { limit: 2, sortBy: "changePct" },
      mode: "replace",
      now,
    });

    // highest changePct among main-board: 600000 (+1.2) then 000636 (+0.73)
    expect(result.entries.map((entry) => entry.symbol)).toEqual(["600000", "000636"]);
    expect(store.readCategory("potential_stocks").entries).toHaveLength(2);
  });
});

describe("persistCategorizedPool", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "secretary-catpool-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists a bucket-tagged pool with a 分类概览 in snapshot metadata", () => {
    const store = new WatchlistMemoryStore({ memoryDir: dir, now: () => new Date(now) });
    const universe: UniverseStock[] = [
      { symbol: "600036", market: "SSE", name: "招商银行", latestPrice: 40, changePct: 10.0, turnoverRate: 2, amount: 5e9, marketCap: 1e12 },
      { symbol: "601398", market: "SSE", name: "工商银行", latestPrice: 5, changePct: -10.0, turnoverRate: 1, amount: 3e9, marketCap: 2e12 },
      { symbol: "600030", market: "SSE", name: "中信证券", latestPrice: 25, changePct: 6.5, turnoverRate: 3, amount: 1e9, marketCap: 4e11 },
      { symbol: "600000", market: "SSE", name: "浦发银行", latestPrice: 10, changePct: 0.2, turnoverRate: 0.5, amount: 9e9, marketCap: 3e11 },
      { symbol: "300750", market: "SZSE", name: "宁德时代", latestPrice: 200, changePct: 9, turnoverRate: 1, amount: 5e9, marketCap: 9e11 }, // 创业板 → dropped
    ].map((stock) => universeStockSchema.parse(stock));

    const result = persistCategorizedPool({
      universe,
      writer: store,
      heldSymbols: ["600000"],
      now,
    });

    // 600000 held → position (not amount_top, despite biggest 成交额); 创业板 excluded.
    expect(result.counts.position).toBe(1);
    expect(result.counts.limit_up).toBe(1);
    expect(result.counts.limit_down).toBe(1);
    expect(result.overview).toContain("观察池");
    expect(result.overview).toContain("招商银行(600036 +10.00%)");

    const persisted = store.readCategory("watchlist_today");
    expect(persisted.metadata.categorized).toBe(true);
    expect(persisted.metadata.poolOverview).toContain("观察池");
    const cmb = persisted.entries.find((entry) => entry.symbol === "600036");
    expect(cmb?.metadata.bucket).toBe("limit_up");
    expect(persisted.entries.every((entry) => /^(600|601|000)/.test(entry.symbol))).toBe(true);
    expect(persisted.entries.some((entry) => entry.symbol === "300750")).toBe(false);
  });

  it("applies dynamic priority: 放量/加速 bump, 缩量走弱 demote, 持仓/涨停 floored at high", () => {
    const store = new WatchlistMemoryStore({ memoryDir: dir, now: () => new Date(now) });
    const universe: UniverseStock[] = [
      { symbol: "600101", market: "SSE", name: "放量股", latestPrice: 20, changePct: 6, turnoverRate: 20, amount: 1e9, marketCap: 5e10 },
      { symbol: "600102", market: "SSE", name: "加速股", latestPrice: 20, changePct: 6, turnoverRate: 5, amount: 9e8, marketCap: 5e10 },
      { symbol: "601398", market: "SSE", name: "缩量跌停", latestPrice: 5, changePct: -10, turnoverRate: 0.5, amount: 3e8, marketCap: 2e12 },
      { symbol: "600036", market: "SSE", name: "缩量涨停", latestPrice: 40, changePct: 10, turnoverRate: 0.5, amount: 2e8, marketCap: 1e12 },
    ].map((stock) => universeStockSchema.parse(stock));

    const result = persistCategorizedPool({
      universe,
      writer: store,
      priorChangeBySymbol: { "600102": 1.0 }, // 加速股 +6 vs prior +1 → +5 delta
      now,
    });

    const priorityOf = (symbol: string) => result.entries.find((entry) => entry.symbol === symbol)?.priority;
    expect(priorityOf("600101")).toBe("high"); // change_top(medium) + 放量 → high
    expect(priorityOf("600102")).toBe("high"); // change_top(medium) + 加速 → high
    expect(priorityOf("601398")).toBe("low"); // limit_down(medium) + 缩量走弱 → low
    expect(priorityOf("600036")).toBe("high"); // limit_up floored at high despite 缩量
  });

  it("uses 主力净流入 (北向 replacement) for priority and surfaces a 资金面 line", () => {
    const store = new WatchlistMemoryStore({ memoryDir: dir, now: () => new Date(now) });
    const universe: UniverseStock[] = [
      { symbol: "600201", market: "SSE", name: "主力流入股", latestPrice: 20, changePct: 5, turnoverRate: 5, amount: 2e9, marketCap: 5e10, mainNetInflow: 250_000_000 },
      { symbol: "600202", market: "SSE", name: "主力流出股", latestPrice: 20, changePct: 5, turnoverRate: 5, amount: 1.9e9, marketCap: 5e10, mainNetInflow: -250_000_000 },
    ].map((stock) => universeStockSchema.parse(stock));

    const result = persistCategorizedPool({ universe, writer: store, now });

    const priorityOf = (symbol: string) => result.entries.find((entry) => entry.symbol === symbol)?.priority;
    expect(priorityOf("600201")).toBe("high"); // change_top(medium) + 主力净流入 → high
    expect(priorityOf("600202")).toBe("low"); // change_top(medium) + 主力净流出 → low
    expect(result.overview).toContain("资金面");
    const persisted = store.readCategory("watchlist_today");
    expect(persisted.entries.find((e) => e.symbol === "600201")?.metadata.mainNetInflow).toBe(250_000_000);
  });

  it("does not overwrite a good pool with an empty categorization when skipWriteWhenEmpty", () => {
    const store = new WatchlistMemoryStore({ memoryDir: dir, now: () => new Date(now) });
    const result = persistCategorizedPool({
      universe: [], // empty universe → empty categorization
      writer: store,
      skipWriteWhenEmpty: true,
      now,
    });
    expect(result.written).toBe(0);
    expect(result.write.filePath).toContain("skipped");
  });
});
