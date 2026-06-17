import { describe, expect, it } from "vitest";
import {
  MarketIndicatorError,
  calculateKlineTechnicalIndicators,
  calculateMovingAverage,
  klineBarSchema,
  type KlineBar,
} from "../../src/domain/market/index.js";

describe("market history indicators", () => {
  it("calculates MA5, MA10, MA20, 60-day range position, and uptrend", () => {
    const bars = makeBars(Array.from({ length: 60 }, (_, index) => index + 1));

    const indicators = calculateKlineTechnicalIndicators(bars);

    expect(indicators).toMatchObject({
      symbol: "000636",
      market: "SZSE",
      period: "1d",
      asOfDate: "2026-03-01",
      sampleSize: 60,
      ma5: 58,
      ma10: 55.5,
      ma20: 50.5,
      high60: 60,
      low60: 1,
      rangePosition60: 1,
      trend: "uptrend",
    });
  });

  it("classifies a downtrend", () => {
    const bars = makeBars(Array.from({ length: 60 }, (_, index) => 60 - index));

    expect(calculateKlineTechnicalIndicators(bars).trend).toBe("downtrend");
  });

  it("classifies mixed moving averages as sideways", () => {
    const closes = Array.from({ length: 60 }, (_, index) => 60 - index);
    closes[59] = 50;
    const bars = makeBars(closes);

    expect(calculateKlineTechnicalIndicators(bars).trend).toBe("sideways");
  });

  it("marks trend as insufficient when MA20 cannot be calculated", () => {
    const bars = makeBars(Array.from({ length: 10 }, (_, index) => index + 1));

    const indicators = calculateKlineTechnicalIndicators(bars);

    expect(indicators.ma20).toBeUndefined();
    expect(indicators.trend).toBe("insufficient_data");
  });

  it("handles a flat 60-day range without division by zero", () => {
    const bars = makeBars(Array.from({ length: 60 }, () => 10));

    expect(calculateKlineTechnicalIndicators(bars).rangePosition60).toBe(0.5);
  });

  it("sorts bars by trade date before calculating moving averages", () => {
    const bars = makeBars(Array.from({ length: 10 }, (_, index) => index + 1)).reverse();

    expect(calculateMovingAverage(bars, 5)).toBe(8);
  });

  it("rejects empty input and invalid windows", () => {
    expect(() => calculateKlineTechnicalIndicators([])).toThrow(MarketIndicatorError);
    expect(() => calculateMovingAverage(makeBars([1]), 0)).toThrow(MarketIndicatorError);
  });
});

function makeBars(closes: number[]): KlineBar[] {
  return closes.map((close, index) =>
    klineBarSchema.parse({
      symbol: "000636",
      market: "SZSE",
      provider: "tencent",
      period: "1d",
      tradeDate: makeTradeDate(index),
      open: close,
      close,
      high: close,
      low: close,
      volume: 1000 + index,
      rawSymbol: "sz000636",
    }),
  );
}

function makeTradeDate(index: number): string {
  const date = new Date(Date.UTC(2026, 0, 1 + index));
  return date.toISOString().slice(0, 10);
}
