import {
  calculateKlineTechnicalIndicators,
  sortKlineBars,
  type StockSymbolInfo,
} from "../domain/market/index.js";
import type { HistoryProvider } from "../infrastructure/providers/index.js";
import type { AskIndex, AskTechnical } from "./ask-portfolio.js";

export interface AsOfMarketReaderOptions {
  historyProvider: HistoryProvider;
  /** Optional as-of index source; absent in P0 (indices default to []). */
  indexSource?: AsOfIndexSource;
  /** Bars requested per symbol before the as-of filter (default 60). */
  historyCount?: number;
}

/** An index snapshot carrying its as-of bar date, so the snapshot can prove no look-ahead. */
export interface AsOfIndex extends AskIndex {
  asOfDate: string;
}

export interface AsOfIndexSource {
  getIndicesAsOf(asOfDate: string, inclusive: boolean): Promise<AsOfIndex[]>;
}

export interface BuildAsOfMarketContextInput {
  symbols: StockSymbolInfo[];
  /** YYYY-MM-DD Beijing trading date the snapshot is anchored to. */
  asOfDate: string;
  /** true = same-day bar is settled (post-close); false = strictly before asOfDate. */
  inclusive: boolean;
  /** Override the per-symbol bar count for this call. */
  count?: number;
}

export interface AsOfPriceSource {
  source: "as_of_close";
  tradeDate: string;
}

export interface AsOfMarketContext {
  technicals: AskTechnical[];
  /** symbol -> as-of close price (only symbols with a surviving bar). */
  prices: Record<string, number>;
  /** symbol -> the bar date its price/technical came from (all <= asOfDate). */
  priceSources: Record<string, AsOfPriceSource>;
  historyAsOfDates: Record<string, string>;
  indices: AsOfIndex[];
  pricesAvailable: boolean;
  degraded: boolean;
  degradedReasons: string[];
}

const DEFAULT_HISTORY_COUNT = 60;

/**
 * THE single as-of seam for replay/backtests. Given a set of symbols and an as-of
 * trading date, it fetches each symbol's daily bars bounded to that date, then
 * DEFENSIVELY re-filters `tradeDate <= asOfDate` (or strict `<` for pre-close
 * nodes) BEFORE computing indicators — so no future bar can leak in even if the
 * underlying provider ignores `endDate`. Prices are the last surviving bar close
 * (there is no live quote provider in replay). A symbol with no surviving bar is
 * degraded (recorded + skipped), never thrown. No LLM, no broker, no live quotes.
 */
export class AsOfMarketReader {
  private readonly historyProvider: HistoryProvider;
  private readonly indexSource?: AsOfIndexSource;
  private readonly historyCount: number;

  constructor(options: AsOfMarketReaderOptions) {
    this.historyProvider = options.historyProvider;
    this.indexSource = options.indexSource;
    this.historyCount = options.historyCount ?? DEFAULT_HISTORY_COUNT;
  }

  async buildAsOfMarketContext(input: BuildAsOfMarketContextInput): Promise<AsOfMarketContext> {
    const count = input.count ?? this.historyCount;
    const technicals: AskTechnical[] = [];
    const prices: Record<string, number> = {};
    const priceSources: Record<string, AsOfPriceSource> = {};
    const historyAsOfDates: Record<string, string> = {};
    const degradedReasons: string[] = [];

    for (const symbol of input.symbols) {
      try {
        // Fetch one extra bar so the strict-`<` (pre-close) case still yields a full window.
        const raw = await this.historyProvider.getDailyKlines(symbol, {
          endDate: input.asOfDate,
          count: count + 1,
        });
        const surviving = sortKlineBars(raw)
          .filter((bar) =>
            input.inclusive ? bar.tradeDate <= input.asOfDate : bar.tradeDate < input.asOfDate,
          )
          .slice(-count);

        if (surviving.length === 0) {
          degradedReasons.push(`${symbol.symbol}: no bar on/before ${input.asOfDate}`);
          continue;
        }

        const indicators = calculateKlineTechnicalIndicators(surviving);
        const lastBar = surviving[surviving.length - 1]!;

        technicals.push({
          symbol: indicators.symbol,
          market: indicators.market,
          name: symbol.name,
          asOfDate: indicators.asOfDate,
          trend: indicators.trend,
          ma5: indicators.ma5,
          ma10: indicators.ma10,
          ma20: indicators.ma20,
          high60: indicators.high60,
          low60: indicators.low60,
          rangePosition60: indicators.rangePosition60,
        });
        prices[indicators.symbol] = lastBar.close;
        priceSources[indicators.symbol] = { source: "as_of_close", tradeDate: indicators.asOfDate };
        historyAsOfDates[indicators.symbol] = indicators.asOfDate;
      } catch (error) {
        degradedReasons.push(
          `${symbol.symbol}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const indices = this.indexSource
      ? await this.indexSource.getIndicesAsOf(input.asOfDate, input.inclusive).catch(() => [])
      : [];

    return {
      technicals,
      prices,
      priceSources,
      historyAsOfDates,
      indices,
      pricesAvailable: Object.keys(prices).length > 0,
      degraded: degradedReasons.length > 0,
      degradedReasons,
    };
  }
}
