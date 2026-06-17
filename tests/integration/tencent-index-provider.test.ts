import { describe, expect, it } from "vitest";
import { isMainBoardSymbol } from "../../src/domain/risk/index.js";
import {
  IndexProviderError,
  TencentIndexProvider,
  parseTencentIndexLine,
  parseTencentIndexResponse,
  resolveTencentIndexSymbol,
  type FetchLike,
} from "../../src/infrastructure/providers/index.js";

const receivedAt = "2026-06-16T02:00:00.000Z";

describe("TencentIndexProvider parser", () => {
  it("converts Tencent index lines into IndexSnapshot", () => {
    const snapshot = parseTencentIndexLine(sampleIndexLine("sh", "000001", "SSE Composite"), receivedAt);

    expect(snapshot).toMatchObject({
      indexId: "sse_composite",
      code: "000001",
      market: "SSE",
      name: "SSE Composite",
      provider: "tencent",
      latestPrice: 3010.5,
      previousClose: 3000,
      openPrice: 3002,
      highPrice: 3020,
      lowPrice: 2990,
      changeAmount: 10.5,
      changePct: 0.0035,
      volume: 123456,
      turnover: 78901234,
      providerTime: "2026-06-16T06:59:03.000Z",
      receivedAt,
      rawSymbol: "sh000001",
      tradingAllowed: false,
    });
  });

  it("parses supported index batch responses and skips unknown or malformed lines", () => {
    const snapshots = parseTencentIndexResponse(
      [
        sampleIndexLine("sh", "000001", "SSE Composite"),
        sampleIndexLine("sz", "399001", "SZSE Component"),
        sampleIndexLine("sz", "399006", "ChiNext"),
        sampleIndexLine("sh", "000688", "STAR 50"),
        sampleIndexLine("sh", "999999", "Unknown"),
        "bad line",
      ].join("\n"),
      receivedAt,
    );

    expect(snapshots.map((snapshot) => snapshot.indexId)).toEqual([
      "sse_composite",
      "szse_component",
      "chinext",
      "star50",
    ]);
  });

  it("parses negative index change percentages from Tencent fields", () => {
    const line = sampleIndexLine("sh", "000001", "SSE Composite", {
      latestPrice: "2980.00",
      previousClose: "3000.00",
      changePct: "-0.67",
    });

    expect(parseTencentIndexLine(line, receivedAt)).toMatchObject({
      latestPrice: 2980,
      previousClose: 3000,
      changeAmount: -20,
      changePct: -0.0067,
    });
  });

  it("resolves supported index ids and keeps STAR 50 as observation-only", () => {
    expect(resolveTencentIndexSymbol("star50")).toEqual({
      indexId: "star50",
      rawSymbol: "sh000688",
    });
    expect(isMainBoardSymbol("688001", "SSE")).toBe(false);
    expect(parseTencentIndexLine(sampleIndexLine("sh", "000688", "STAR 50"), receivedAt))
      .toMatchObject({
        indexId: "star50",
        tradingAllowed: false,
      });
  });
});

describe("TencentIndexProvider with mocked fetch", () => {
  it("fetches default index snapshots with injected fetch", async () => {
    const fetchCalls: string[] = [];
    const provider = new TencentIndexProvider({
      now: () => new Date(receivedAt),
      fetchImpl: async (url) => {
        fetchCalls.push(url);
        return okResponse(
          [
            sampleIndexLine("sh", "000001", "SSE Composite"),
            sampleIndexLine("sz", "399001", "SZSE Component"),
            sampleIndexLine("sz", "399006", "ChiNext"),
            sampleIndexLine("sh", "000688", "STAR 50"),
          ].join("\n"),
        );
      },
    });

    const snapshots = await provider.getIndexes();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("sh000001,sz399001,sz399006,sh000688");
    expect(snapshots).toHaveLength(4);
    expect(snapshots.every((snapshot) => snapshot.tradingAllowed === false)).toBe(true);
  });

  it("throws clear errors on HTTP failures, empty responses, bad data, and timeout", async () => {
    await expect(
      new TencentIndexProvider({
        fetchImpl: async () => ({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          text: async () => "",
        }),
      }).getIndexes(["sse_composite"]),
    ).rejects.toThrow(IndexProviderError);

    await expect(
      new TencentIndexProvider({
        fetchImpl: async () => okResponse(""),
      }).getIndexes(["sse_composite"]),
    ).rejects.toThrow(/did not contain any valid index snapshots/);

    await expect(
      new TencentIndexProvider({
        fetchImpl: async () => okResponse(sampleBadIndexLine()),
      }).getIndexes(["sse_composite"]),
    ).rejects.toThrow(/did not contain any valid index snapshots/);

    await expect(
      new TencentIndexProvider({
        timeoutMs: 1,
        fetchImpl: (_url, init) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      }).getIndexes(["sse_composite"]),
    ).rejects.toThrow(IndexProviderError);
  });
});

function sampleIndexLine(
  marketPrefix: "sh" | "sz",
  code: string,
  name: string,
  overrides: {
    latestPrice?: string;
    previousClose?: string;
    changePct?: string;
  } = {},
): string {
  const parts = Array.from({ length: 50 }, () => "");
  parts[0] = "51";
  parts[1] = name;
  parts[2] = code;
  parts[3] = overrides.latestPrice ?? "3010.50";
  parts[4] = overrides.previousClose ?? "3000.00";
  parts[5] = "3002.00";
  parts[6] = "123456";
  parts[30] = "20260616145903";
  parts[32] = overrides.changePct ?? "0.35";
  parts[33] = "3020.00";
  parts[34] = "2990.00";
  parts[37] = "78901234";

  return `v_${marketPrefix}${code}="${parts.join("~")}";`;
}

function sampleBadIndexLine(): string {
  const parts = Array.from({ length: 10 }, () => "");
  parts[1] = "Bad";
  parts[2] = "000001";
  parts[3] = "";
  return `v_sh000001="${parts.join("~")}";`;
}

function okResponse(text: string): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => text,
  });
}
