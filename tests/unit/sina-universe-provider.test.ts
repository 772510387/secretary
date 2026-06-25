import { describe, expect, it } from "vitest";
import {
  SinaUniverseProvider,
  UniverseProviderError,
  parseSinaUniverse,
  type UniverseFetchResponse,
} from "../../src/infrastructure/providers/index.js";

const sample = JSON.stringify([
  { symbol: "sh600519", code: "600519", name: "贵州茅台", trade: "1600.50", changepercent: "0.20", turnoverratio: "0.30", volume: "12345", amount: "4000000000", mktcap: "200000000" },
  { symbol: "sz000636", code: "000636", name: "风华高科", trade: "74.60", changepercent: "0.73", turnoverratio: "3.20", volume: "84117", amount: "800000000", mktcap: "8000000" },
  { symbol: "bj830000", code: "830000", name: "北交所股", trade: "5", changepercent: "1", turnoverratio: "1", volume: "1", amount: "1", mktcap: "1" },
]);

function ok(text: string): UniverseFetchResponse {
  return { ok: true, status: 200, text: async () => text };
}

describe("parseSinaUniverse", () => {
  it("maps Sina rows, derives market from prefix, and converts 万元 mktcap to yuan", () => {
    const stocks = parseSinaUniverse(sample);
    // bj (北交所) is skipped.
    expect(stocks.map((s) => s.symbol)).toEqual(["600519", "000636"]);

    const maotai = stocks.find((s) => s.symbol === "600519");
    expect(maotai).toMatchObject({ market: "SSE", latestPrice: 1600.5, changePct: 0.2, amount: 4_000_000_000 });
    expect(maotai?.marketCap).toBe(2_000_000_000_000); // 2e8 万元 → 2e12 元

    expect(stocks.find((s) => s.symbol === "000636")?.market).toBe("SZSE");
  });

  it("treats null/empty as past-the-last-page (empty), throws on bad JSON", () => {
    expect(parseSinaUniverse("null")).toEqual([]);
    expect(() => parseSinaUniverse("not json")).toThrow(UniverseProviderError);
  });
});

describe("SinaUniverseProvider", () => {
  it("pushes sort down and stops at the first empty page", async () => {
    const urls: string[] = [];
    const provider = new SinaUniverseProvider({
      interBatchDelayMs: 0,
      fetchImpl: async (url) => {
        urls.push(url);
        return ok(urls.length === 1 ? sample : "null"); // page 2 is empty → stop
      },
    });

    const stocks = await provider.getUniverse({ sortBy: "amount", descending: true, targetCount: 80 });
    expect(stocks.map((s) => s.symbol)).toEqual(["600519", "000636"]);
    expect(urls).toHaveLength(2); // page 1 (rows) + page 2 (empty) then break
    expect(urls[0]).toContain("sort=amount");
    expect(urls[0]).toContain("asc=0");
    expect(urls[0]).toContain("node=hs_a");
  });

  it("raises a clear error on HTTP failure", async () => {
    const provider = new SinaUniverseProvider({
      maxRetries: 0,
      fetchImpl: async () => ({ ok: false, status: 503, statusText: "x", text: async () => "" }),
    });
    await expect(provider.getUniverse({ targetCount: 10 })).rejects.toThrow(UniverseProviderError);
  });
});
