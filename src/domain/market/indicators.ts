import { klineTechnicalIndicatorsSchema, type KlineBar, type KlineTechnicalIndicators } from "./schemas.js";

const PRICE_DECIMALS = 4;
const RATIO_DECIMALS = 6;

export function calculateMovingAverage(
  bars: KlineBar[],
  windowSize: number,
): number | undefined {
  assertPositiveInteger(windowSize, "windowSize");

  if (bars.length < windowSize) {
    return undefined;
  }

  const sortedBars = sortKlineBars(bars);
  const window = sortedBars.slice(-windowSize);
  const closeSum = window.reduce((sum, bar) => sum + bar.close, 0);

  return roundPrice(closeSum / windowSize);
}

export function calculateKlineTechnicalIndicators(
  bars: KlineBar[],
): KlineTechnicalIndicators {
  if (bars.length === 0) {
    throw new MarketIndicatorError("At least one kline bar is required");
  }

  const sortedBars = sortKlineBars(bars);
  const latestBar = sortedBars[sortedBars.length - 1]!;
  const recent60 = sortedBars.slice(-60);
  const high60 = roundPrice(Math.max(...recent60.map((bar) => bar.high)));
  const low60 = roundPrice(Math.min(...recent60.map((bar) => bar.low)));
  const ma5 = calculateMovingAverage(sortedBars, 5);
  const ma10 = calculateMovingAverage(sortedBars, 10);
  const ma20 = calculateMovingAverage(sortedBars, 20);

  return klineTechnicalIndicatorsSchema.parse({
    symbol: latestBar.symbol,
    market: latestBar.market,
    period: latestBar.period,
    asOfDate: latestBar.tradeDate,
    sampleSize: sortedBars.length,
    ma5,
    ma10,
    ma20,
    high60,
    low60,
    rangePosition60: calculateRangePosition(latestBar.close, low60, high60),
    trend: classifyKlineTrend(latestBar.close, ma5, ma10, ma20),
  });
}

export function sortKlineBars(bars: KlineBar[]): KlineBar[] {
  return [...bars].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
}

export class MarketIndicatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketIndicatorError";
  }
}

function classifyKlineTrend(
  latestClose: number,
  ma5: number | undefined,
  ma10: number | undefined,
  ma20: number | undefined,
): KlineTechnicalIndicators["trend"] {
  if (ma5 === undefined || ma10 === undefined || ma20 === undefined) {
    return "insufficient_data";
  }

  if (latestClose >= ma5 && ma5 >= ma10 && ma10 >= ma20) {
    return "uptrend";
  }

  if (latestClose <= ma5 && ma5 <= ma10 && ma10 <= ma20) {
    return "downtrend";
  }

  return "sideways";
}

function calculateRangePosition(close: number, low: number, high: number): number {
  if (high === low) {
    return 0.5;
  }

  const bounded = Math.min(Math.max((close - low) / (high - low), 0), 1);
  return roundRatio(bounded);
}

function roundPrice(value: number): number {
  return roundTo(value, PRICE_DECIMALS);
}

function roundRatio(value: number): number {
  return roundTo(value, RATIO_DECIMALS);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const epsilon = Number.EPSILON * Math.sign(value || 1);
  return Math.round((value + epsilon) * factor) / factor;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new MarketIndicatorError(`${name} must be a positive integer`);
  }
}
