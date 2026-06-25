import { describe, expect, it } from "vitest";
import {
  EastmoneyUniverseProvider,
  UniverseProviderError,
  parseUniverse,
  type UniverseFetchResponse,
} from "../../src/infrastructure/providers/index.js";

const sample = JSON.stringify({
  data: {
    total: 3,
    diff: [
      { f12: "600519", f13: 1, f14: "贵州茅台", f2: 1600.5, f3: 0.2, f5: 12345, f6: 4_000_000_000, f8: 0.3, f20: 2_000_000_000_000, f100: "白酒" },
      { f12: "000636", f13: 0, f14: "风华高科", f2: 74.6, f3: 0.73, f5: 84117, f6: 800_000_000, f8: 3.2, f20: 80_000_000_000, f100: "-" },
      { f12: "688981", f13: 1, f14: "中芯国际", f2: 50, f3: 3.0, f5: 0, f6: "-", f8: "-", f20: 400_000_000_000, f100: "半导体" },
    ],
  },
});

function ok(text: string): UniverseFetchResponse {
  return { ok: true, status: 200, text: async () => text };
}

describe("parseUniverse", () => {
  it("maps Eastmoney rows to UniverseStock with correct market + clean floats", () => {
    const stocks = parseUniverse(sample);
    expect(stocks).toHaveLength(3);

    const maotai = stocks.find((s) => s.symbol === "600519");
    expect(maotai).toMatchObject({ market: "SSE", name: "贵州茅台", latestPrice: 1600.5, changePct: 0.2 });

    const fenghua = stocks.find((s) => s.symbol === "000636");
    expect(fenghua?.market).toBe("SZSE");
    expect(fenghua?.turnoverRate).toBe(3.2);

    // "-" fields (halted) become undefined, not NaN.
    const smic = stocks.find((s) => s.symbol === "688981");
    expect(smic?.amount).toBeUndefined();
    expect(smic?.turnoverRate).toBeUndefined();

    // f100 (所属行业) → sector; "-" means absent → undefined.
    expect(maotai?.sector).toBe("白酒");
    expect(smic?.sector).toBe("半导体");
    expect(fenghua?.sector).toBeUndefined();
  });

  it("throws on malformed payloads", () => {
    expect(() => parseUniverse("not json")).toThrow(UniverseProviderError);
    expect(() => parseUniverse(JSON.stringify({ data: {} }))).toThrow(/no data.diff/);
  });

  it("handles diff as an object map too", () => {
    const objShape = JSON.stringify({ data: { diff: { "0": { f12: "600000", f13: 1, f14: "浦发银行", f2: 10 } } } });
    expect(parseUniverse(objShape).map((s) => s.symbol)).toEqual(["600000"]);
  });
});

describe("EastmoneyUniverseProvider", () => {
  it("fetches and parses the universe", async () => {
    const provider = new EastmoneyUniverseProvider({ fetchImpl: async () => ok(sample) });
    const stocks = await provider.getUniverse();
    expect(stocks.map((s) => s.symbol)).toEqual(["600519", "000636", "688981"]);
  });

  it("raises a clear error on HTTP failure", async () => {
    const provider = new EastmoneyUniverseProvider({
      maxRetries: 0,
      fetchImpl: async () => ({ ok: false, status: 503, statusText: "x", text: async () => "" }),
    });
    await expect(provider.getUniverse()).rejects.toThrow(UniverseProviderError);
  });

  it("raises a clear error on an empty body", async () => {
    const provider = new EastmoneyUniverseProvider({ maxRetries: 0, fetchImpl: async () => ok("") });
    await expect(provider.getUniverse()).rejects.toThrow(/empty/);
  });

  it("pushes sort/board down and fetches only the pages needed for targetCount", async () => {
    const urls: string[] = [];
    const page = (): UniverseFetchResponse => {
      const diff = Array.from({ length: 100 }, (_, i) => ({
        f12: String(600000 + urls.length * 100 + i),
        f13: 1,
        f14: `股${i}`,
        f2: 10,
        f3: 1,
        f5: 1,
        f6: 1e9,
        f8: 1,
        f20: 1e10,
      }));
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { total: 5534, diff } }) };
    };
    const provider = new EastmoneyUniverseProvider({
      interBatchDelayMs: 0,
      fetchImpl: async (url) => {
        urls.push(url);
        return page();
      },
    });

    const stocks = await provider.getUniverse({
      sortBy: "changePct",
      descending: true,
      mainBoardOnly: true,
      targetCount: 100,
    });

    // targetCount 100 × margin 3 = 300 rows → ceil(300/100) = 3 pages, not the full ~56.
    expect(urls).toHaveLength(3);
    expect(stocks).toHaveLength(300);
    expect(urls[0]).toContain("fid=f3"); // changePct -> f3 (server-side sort)
    expect(urls[0]).toContain("po=1"); // descending
    expect(urls[0]).toContain("fs=m:0+t:6,m:1+t:2"); // main board only
  });
});
