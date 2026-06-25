import {
  calculateKlineTechnicalIndicators,
  klineBarSchema,
  normalizeStockSymbol,
  sortKlineBars,
  type KlineBar,
  type KlineTechnicalIndicators,
  type StockSymbolInfo,
} from "../../domain/market/index.js";
import type { HistoryProvider, HistoryQueryOptions } from "./tencent-history-provider.js";

/**
 * A deterministic in-memory {@link HistoryProvider} backed by a fixed map of daily
 * bars. Used for replay/backtest regression so context-building never touches the
 * network. It honors `endDate` (returns only bars with `tradeDate <= endDate`) and
 * `count` (the most recent N), mirroring how a real provider would bound a window —
 * which lets the as-of reader's defensive re-filter be exercised exactly.
 */
export class FixtureHistoryProvider implements HistoryProvider {
  private readonly barsBySymbol: Map<string, KlineBar[]>;

  constructor(barsBySymbol: Record<string, KlineBar[]> | Map<string, KlineBar[]>) {
    const entries =
      barsBySymbol instanceof Map ? [...barsBySymbol.entries()] : Object.entries(barsBySymbol);
    this.barsBySymbol = new Map(
      entries.map(([symbol, bars]) => [
        normalizeStockSymbol(symbol).symbol,
        sortKlineBars(bars.map((bar) => klineBarSchema.parse(bar))),
      ]),
    );
  }

  async getDailyKlines(
    symbol: string | StockSymbolInfo,
    options: HistoryQueryOptions = {},
  ): Promise<KlineBar[]> {
    const key = normalizeStockSymbol(symbol).symbol;
    const all = this.barsBySymbol.get(key) ?? [];
    const windowed = options.endDate
      ? all.filter((bar) => bar.tradeDate <= options.endDate!)
      : all;
    const count = options.count ?? 60;
    return windowed.slice(-count);
  }

  async getDailyTechnicalIndicators(
    symbol: string | StockSymbolInfo,
    options: HistoryQueryOptions = {},
  ): Promise<KlineTechnicalIndicators> {
    const bars = await this.getDailyKlines(symbol, options);
    return calculateKlineTechnicalIndicators(bars);
  }
}
