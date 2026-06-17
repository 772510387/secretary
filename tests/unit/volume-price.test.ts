import { describe, expect, it } from "vitest";
import {
  VolumePriceSignalError,
  calculateKlineVolumePriceSignal,
  calculateQuoteVolumePriceSignal,
  klineBarSchema,
  quoteSnapshotSchema,
  type KlineBar,
  type QuoteSnapshot,
} from "../../src/domain/market/index.js";

describe("volume price radar calculations", () => {
  it("labels volume and price rising from kline bars", () => {
    const bars = [
      ...makeBars([10, 10.2, 10.1, 10.3], [1000, 1100, 900, 1000]),
      makeBar({
        close: 10.7,
        volume: 3000,
        tradeDate: "2026-01-05",
      }),
    ];

    const signal = calculateKlineVolumePriceSignal(bars, {
      averageWindow: 4,
      volumeSurgeRatio: 2,
      priceRiseThreshold: 0.02,
      lowLiquidityVolume: 100,
    });

    expect(signal).toMatchObject({
      signalId: "volume-kline-SZSE-000636-2026-01-05",
      labels: ["volume_price_rise"],
      liquidity: "normal",
      latestVolume: 3000,
      averageVolume: 1000,
      relativeVolume: 3,
      priceChangePct: 0.038835,
      metadata: {
        source: "kline",
        brokerConnected: false,
        liveTrading: false,
      },
    });
  });

  it("labels volume stagnation when volume surges but price barely moves", () => {
    const bars = [
      ...makeBars([10, 10, 10], [1000, 1000, 1000]),
      makeBar({
        close: 10.03,
        volume: 2600,
        tradeDate: "2026-01-04",
      }),
    ];

    const signal = calculateKlineVolumePriceSignal(bars, {
      averageWindow: 3,
      volumeSurgeRatio: 2,
      stagnationAbsThreshold: 0.005,
      lowLiquidityVolume: 100,
    });

    expect(signal.labels).toEqual(["volume_stagnation"]);
    expect(signal.priceChangePct).toBe(0.003);
  });

  it("marks suspended or no-volume bars without creating an order signal", () => {
    const signal = calculateKlineVolumePriceSignal(
      [
        ...makeBars([10, 10.1], [1000, 1000]),
        makeBar({
          close: 10.1,
          volume: 0,
          tradeDate: "2026-01-03",
        }),
      ],
      {
        averageWindow: 2,
      },
    );

    expect(signal.labels).toEqual(["suspended_or_no_volume"]);
    expect(signal.liquidity).toBe("suspended");
    expect(signal.metadata).toMatchObject({
      brokerConnected: false,
      liveTrading: false,
    });
  });

  it("handles quote snapshots with missing volume as insufficient data", () => {
    const signal = calculateQuoteVolumePriceSignal({
      quote: makeQuote({
        volume: undefined,
      }),
    });

    expect(signal.labels).toEqual(["insufficient_data"]);
    expect(signal.liquidity).toBe("unknown");
    expect(signal.latestVolume).toBeUndefined();
  });

  it("labels low liquidity separately from ordinary volume signals", () => {
    const signal = calculateQuoteVolumePriceSignal({
      quote: makeQuote({
        volume: 500,
      }),
      averageVolume: 600,
      previousPrice: 10,
      options: {
        lowLiquidityVolume: 1000,
      },
    });

    expect(signal.labels).toEqual(["low_liquidity"]);
    expect(signal.liquidity).toBe("low");
  });

  it("rejects invalid calculation options", () => {
    expect(() =>
      calculateKlineVolumePriceSignal(makeBars([10], [1000]), {
        averageWindow: 0,
      }),
    ).toThrow(VolumePriceSignalError);
  });
});

function makeBars(closes: number[], volumes: number[]): KlineBar[] {
  return closes.map((close, index) =>
    makeBar({
      close,
      volume: volumes[index] ?? 1000,
      tradeDate: makeTradeDate(index),
    }),
  );
}

function makeBar(input: {
  close: number;
  volume: number;
  tradeDate: string;
}): KlineBar {
  return klineBarSchema.parse({
    symbol: "000636",
    market: "SZSE",
    provider: "tencent",
    period: "1d",
    tradeDate: input.tradeDate,
    open: input.close,
    close: input.close,
    high: input.close,
    low: input.close,
    volume: input.volume,
    rawSymbol: "sz000636",
  });
}

function makeQuote(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return quoteSnapshotSchema.parse({
    symbol: "000636",
    market: "SZSE",
    name: "Fenghua Hi-Tech",
    provider: "tencent",
    latestPrice: 10.2,
    previousClose: 10,
    changeAmount: 0.2,
    changePct: 0.02,
    volume: overrides.volume ?? 2000,
    receivedAt: "2026-06-16T01:30:00.000Z",
    rawSymbol: "sz000636",
    ...overrides,
  });
}

function makeTradeDate(index: number): string {
  const date = new Date(Date.UTC(2026, 0, 1 + index));
  return date.toISOString().slice(0, 10);
}
