import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWatchlistFromScreen,
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
