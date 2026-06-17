import { describe, expect, it } from "vitest";
import {
  HistoryProviderError,
  TencentHistoryProvider,
  parseTencentHistoryResponse,
  parseTencentKlineRow,
  type FetchLike,
} from "../../src/infrastructure/providers/index.js";

describe("TencentHistoryProvider parser", () => {
  it("converts Tencent qfqday rows into KlineBar objects", () => {
    const bars = parseTencentHistoryResponse(sampleHistoryResponse("qfqday"), "sz000636");

    expect(bars).toHaveLength(3);
    expect(bars[0]).toMatchObject({
      symbol: "000636",
      market: "SZSE",
      provider: "tencent",
      period: "1d",
      tradeDate: "2026-06-10",
      open: 60.1,
      close: 61.2,
      high: 62.3,
      low: 59.8,
      volume: 123456,
      turnover: 7890123.45,
      rawSymbol: "sz000636",
    });
  });

  it("falls back to day rows and skips malformed rows", () => {
    const bars = parseTencentHistoryResponse(sampleHistoryResponse("day"), "sh601187");

    expect(bars.map((bar) => `${bar.market}:${bar.symbol}:${bar.tradeDate}`)).toEqual([
      "SSE:601187:2026-06-10",
      "SSE:601187:2026-06-11",
      "SSE:601187:2026-06-12",
    ]);
  });

  it("returns undefined for incomplete or invalid kline rows", () => {
    expect(parseTencentKlineRow(["2026-06-10", "1", "2"], "sz000636")).toBeUndefined();
    expect(
      parseTencentKlineRow(["bad-date", "1", "2", "3", "0.5", "100"], "sz000636"),
    ).toBeUndefined();
    expect(
      parseTencentKlineRow(["2026-06-10", "1", "", "3", "0.5", "100"], "sz000636"),
    ).toBeUndefined();
  });

  it("returns an empty array for malformed JSON or missing data", () => {
    expect(parseTencentHistoryResponse("bad json", "sz000636")).toEqual([]);
    expect(parseTencentHistoryResponse(JSON.stringify({ data: {} }), "sz000636")).toEqual([]);
  });
});

describe("TencentHistoryProvider with mocked fetch", () => {
  it("fetches daily klines with injected fetch", async () => {
    const fetchCalls: string[] = [];
    const provider = new TencentHistoryProvider({
      fetchImpl: async (url) => {
        fetchCalls.push(url);
        return okResponse(sampleHistoryResponse("qfqday"));
      },
    });

    const bars = await provider.getDailyKlines("000636", {
      count: 60,
      endDate: "2026-06-14",
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("sz000636,day,,2026-06-14,60,qfq");
    expect(bars).toHaveLength(3);
    expect(bars[2]?.tradeDate).toBe("2026-06-12");
  });

  it("calculates technical indicators from fetched daily klines", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => {
      const close = index + 1;
      return [
        makeTradeDate(index),
        String(close),
        String(close),
        String(close),
        String(close),
        String(1000 + index),
      ];
    });
    const provider = new TencentHistoryProvider({
      fetchImpl: async () => okResponse(JSON.stringify({ data: { sz000636: { qfqday: rows } } })),
    });

    const indicators = await provider.getDailyTechnicalIndicators("000636");

    expect(indicators).toMatchObject({
      ma5: 58,
      ma10: 55.5,
      ma20: 50.5,
      trend: "uptrend",
    });
  });

  it("throws a clear error on HTTP failures", async () => {
    const provider = new TencentHistoryProvider({
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: async () => "",
      }),
    });

    await expect(provider.getDailyKlines("000636")).rejects.toThrow(HistoryProviderError);
    await expect(provider.getDailyKlines("000636")).rejects.toThrow(/503/);
  });

  it("throws a clear error when the response has no valid klines", async () => {
    const provider = new TencentHistoryProvider({
      fetchImpl: async () => okResponse(JSON.stringify({ data: { sz000636: { qfqday: [] } } })),
    });

    await expect(provider.getDailyKlines("000636")).rejects.toThrow(
      /did not contain any valid daily klines/,
    );
  });

  it("throws a clear error on timeout", async () => {
    const provider = new TencentHistoryProvider({
      timeoutMs: 1,
      fetchImpl: (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    });

    await expect(provider.getDailyKlines("000636")).rejects.toThrow(HistoryProviderError);
    await expect(provider.getDailyKlines("000636")).rejects.toThrow(/failed/);
  });

  it("rejects invalid count before calling fetch", async () => {
    const provider = new TencentHistoryProvider({
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      },
    });

    await expect(provider.getDailyKlines("000636", { count: 0 })).rejects.toThrow(
      /between 1 and 240/,
    );
  });
});

describe.skipIf(process.env.TENCENT_HISTORY_NETWORK !== "1")(
  "TencentHistoryProvider network smoke test",
  () => {
    it("can query Tencent history when explicitly enabled", async () => {
      const provider = new TencentHistoryProvider();
      const bars = await provider.getDailyKlines("000636", { count: 10 });

      expect(bars.length).toBeGreaterThan(0);
      expect(bars[0]?.symbol).toBe("000636");
    });
  },
);

function sampleHistoryResponse(key: "qfqday" | "day"): string {
  const rawSymbol = key === "day" ? "sh601187" : "sz000636";
  return JSON.stringify({
    code: 0,
    data: {
      [rawSymbol]: {
        [key]: [
          ["2026-06-10", "60.10", "61.20", "62.30", "59.80", "123456", "7890123.45"],
          ["bad-row"],
          ["2026-06-12", "62.10", "63.20", "64.30", "61.80", "345678"],
          ["2026-06-11", "61.10", "62.20", "63.30", "60.80", "234567"],
        ],
      },
    },
  });
}

function makeTradeDate(index: number): string {
  const date = new Date(Date.UTC(2026, 0, 1 + index));
  return date.toISOString().slice(0, 10);
}

function okResponse(text: string): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => text,
  });
}
