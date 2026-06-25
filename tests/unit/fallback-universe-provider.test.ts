import { describe, expect, it } from "vitest";
import {
  FallbackUniverseProvider,
  type UniverseProvider,
} from "../../src/infrastructure/providers/index.js";
import {
  universeStockSchema,
  type UniverseQuery,
  type UniverseStock,
} from "../../src/domain/market/index.js";

const rows: UniverseStock[] = [universeStockSchema.parse({ symbol: "600519", market: "SSE", name: "贵州茅台", latestPrice: 1600 })];

function failing(message: string): UniverseProvider {
  return { getUniverse: async () => { throw new Error(message); } };
}

function working(result: UniverseStock[]): UniverseProvider & { calls: number; lastQuery?: UniverseQuery } {
  const provider = {
    calls: 0,
    lastQuery: undefined as UniverseQuery | undefined,
    getUniverse: async (query?: UniverseQuery) => {
      provider.calls += 1;
      provider.lastQuery = query;
      return result;
    },
  };
  return provider;
}

describe("FallbackUniverseProvider", () => {
  it("falls through a failing primary to a working fallback (and forwards the query)", async () => {
    const sina = working(rows);
    const attempts: number[] = [];
    const provider = new FallbackUniverseProvider([failing("other side closed"), sina], {
      onAttemptError: ({ index }) => attempts.push(index),
    });

    const query: UniverseQuery = { sortBy: "amount", targetCount: 100 };
    const out = await provider.getUniverse(query);
    expect(out).toEqual(rows);
    expect(attempts).toEqual([0]); // primary failed
    expect(sina.lastQuery).toEqual(query); // query forwarded to fallback
  });

  it("uses the primary when it works (no fallback)", async () => {
    const primary = working(rows);
    const fallback = working([]);
    const provider = new FallbackUniverseProvider([primary, fallback]);

    await provider.getUniverse({ targetCount: 10 });
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(0);
  });

  it("throws a summary when every source fails", async () => {
    const provider = new FallbackUniverseProvider([failing("eastmoney down"), failing("sina down")]);
    await expect(provider.getUniverse()).rejects.toThrow(/All universe providers failed/);
  });
});
