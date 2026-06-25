import { describe, expect, it } from "vitest";
import {
  normalizeStockSymbol,
  toTencentQuoteSymbol,
} from "../../src/domain/market/index.js";
import {
  QuoteProviderError,
  TencentQuoteProvider,
  parseTencentQuoteLine,
  parseTencentQuoteResponse,
  type FetchLike,
} from "../../src/infrastructure/providers/index.js";

const receivedAt = "2026-06-12T02:00:00.000Z";

describe("TencentQuoteProvider parser", () => {
  it("converts Tencent quote lines into QuoteSnapshot", () => {
    const quote = parseTencentQuoteLine(sampleLine("sz", "000636", "风华高科"), receivedAt);

    expect(quote).toMatchObject({
      symbol: "000636",
      market: "SZSE",
      name: "风华高科",
      provider: "tencent",
      latestPrice: 64.3,
      previousClose: 63,
      openPrice: 63.8,
      highPrice: 65.1,
      lowPrice: 62.9,
      changeAmount: 1.3,
      changePct: 0.0206,
      volume: 123456,
      turnover: 78901234,
      bid1Price: 64.3,
      bid1Volume: 84205,
      ask1Price: 64.31,
      ask1Volume: 1200,
      providerTime: "2026-06-12T06:59:03.000Z",
      receivedAt,
      rawSymbol: "sz000636",
    });
  });

  it("parses batch responses and skips malformed or empty quote lines", () => {
    const quotes = parseTencentQuoteResponse(
      [
        sampleLine("sz", "000636", "风华高科"),
        "bad line",
        sampleLine("sh", "601187", "厦门银行"),
        "",
      ].join("\n"),
      receivedAt,
    );

    expect(quotes.map((quote) => `${quote.market}:${quote.symbol}`)).toEqual([
      "SZSE:000636",
      "SSE:601187",
    ]);
  });
});

describe("TencentQuoteProvider symbols", () => {
  it("normalizes A-share symbols and Tencent query symbols", () => {
    expect(normalizeStockSymbol("000636")).toEqual({
      symbol: "000636",
      market: "SZSE",
    });
    expect(normalizeStockSymbol("sh601187")).toEqual({
      symbol: "601187",
      market: "SSE",
    });
    expect(toTencentQuoteSymbol({ symbol: "601187", market: "SSE" })).toBe("sh601187");
    expect(toTencentQuoteSymbol({ symbol: "000636", market: "SZSE" })).toBe("sz000636");
  });
});

describe("TencentQuoteProvider with mocked fetch", () => {
  it("fetches one quote with injected fetch", async () => {
    const fetchCalls: string[] = [];
    const provider = new TencentQuoteProvider({
      now: () => new Date(receivedAt),
      fetchImpl: async (url) => {
        fetchCalls.push(url);
        return okResponse(`${sampleLine("sz", "000636", "风华高科")}\n`);
      },
    });

    const quote = await provider.getQuote("000636");

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("sz000636");
    expect(quote.symbol).toBe("000636");
    expect(quote.latestPrice).toBe(64.3);
  });

  it("fetches batch quotes with injected fetch", async () => {
    const provider = new TencentQuoteProvider({
      now: () => new Date(receivedAt),
      fetchImpl: async (url) => {
        expect(url).toContain("sz000636,sh601187");
        return okResponse(
          `${sampleLine("sz", "000636", "风华高科")}\n${sampleLine(
            "sh",
            "601187",
            "厦门银行",
          )}\n`,
        );
      },
    });

    const quotes = await provider.getQuotes(["000636", "sh601187"]);

    expect(quotes).toHaveLength(2);
    expect(quotes[0]?.market).toBe("SZSE");
    expect(quotes[1]?.market).toBe("SSE");
  });

  it("throws a clear error on HTTP failures", async () => {
    const provider = new TencentQuoteProvider({
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: async () => "",
      }),
    });

    await expect(provider.getQuote("000636")).rejects.toThrow(QuoteProviderError);
    await expect(provider.getQuote("000636")).rejects.toThrow(/503/);
  });

  it("throws a clear error when the response has no valid quotes", async () => {
    const provider = new TencentQuoteProvider({
      fetchImpl: async () => okResponse("bad response\n"),
    });

    await expect(provider.getQuote("000636")).rejects.toThrow(/did not contain any valid quotes/);
  });
});

describe.skipIf(process.env.TENCENT_QUOTE_NETWORK !== "1")(
  "TencentQuoteProvider network smoke test",
  () => {
    it("can query Tencent when explicitly enabled", async () => {
      const provider = new TencentQuoteProvider();
      const quote = await provider.getQuote("000636");

      expect(quote.symbol).toBe("000636");
      expect(quote.latestPrice).toBeGreaterThanOrEqual(0);
    });
  },
);

function sampleLine(marketPrefix: "sh" | "sz", symbol: string, name: string): string {
  const parts = Array.from({ length: 50 }, () => "");
  parts[0] = "51";
  parts[1] = name;
  parts[2] = symbol;
  parts[3] = "64.30";
  parts[4] = "63.00";
  parts[5] = "63.80";
  parts[6] = "123456";
  parts[9] = "64.30"; // 买一价
  parts[10] = "84205"; // 买一量(手)
  parts[19] = "64.31"; // 卖一价
  parts[20] = "1200"; // 卖一量(手)
  parts[30] = "20260612145903";
  parts[32] = "2.06";
  parts[33] = "65.10";
  parts[34] = "62.90";
  parts[37] = "78901234";

  return `v_${marketPrefix}${symbol}="${parts.join("~")}";`;
}

function okResponse(text: string): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => text,
  });
}

