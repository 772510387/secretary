import { sortKlineBars, type KlineBar, type StockSymbolInfo } from "../domain/market/index.js";
import { forwardOutcomeSchema, type ForwardOutcome } from "../domain/decision/index.js";
import type { HistoryProvider } from "../infrastructure/providers/index.js";

export interface ForwardOutcomeQuery {
  symbol: string | StockSymbolInfo;
  /**
   * The bar date the decision's as-of close came from (for a pre-close node this is
   * the PRIOR trading day, not the snapshot's calendar date). Forward bars are taken
   * STRICTLY after this, so a horizon-N return spans exactly N trading days from the
   * anchor — no hidden overnight gap.
   */
  fromDate: string;
  /** The as-of close the decision was anchored to (the return denominator). */
  fromClose: number;
  horizonTradingDays: number;
}

const DEFAULT_FETCH_COUNT = 240;

/**
 * ⚠️ FENCED LOOK-AHEAD. This is the ONLY component permitted to read bars dated
 * AFTER `asOfDate`, and ONLY to evaluate a decision that was already made. It must
 * never feed a decision — keeping it a separate, explicitly-named reader (not part
 * of {@link AsOfMarketReader}) is the architectural fence that keeps evaluation from
 * contaminating the as-of context.
 *
 * The outcome is the realized close `horizonTradingDays` trading days forward. If
 * there are not enough forward bars yet, it is `realized: false` (score = null, not
 * a misleading zero).
 */
export class ForwardOutcomeReader {
  private readonly historyProvider: HistoryProvider;
  private readonly fetchCount: number;

  constructor(historyProvider: HistoryProvider, fetchCount: number = DEFAULT_FETCH_COUNT) {
    this.historyProvider = historyProvider;
    this.fetchCount = fetchCount;
  }

  async getForwardOutcome(query: ForwardOutcomeQuery): Promise<ForwardOutcome> {
    const horizon = query.horizonTradingDays;

    let forwardBars: KlineBar[];
    try {
      const bars = sortKlineBars(
        await this.historyProvider.getDailyKlines(query.symbol, { count: this.fetchCount }),
      );
      forwardBars = bars.filter((bar) => bar.tradeDate > query.fromDate);
    } catch {
      forwardBars = [];
    }

    if (forwardBars.length < horizon || query.fromClose <= 0) {
      // Canonical unrealized: all from/to fields null (deterministic "no data yet").
      return forwardOutcomeSchema.parse({
        horizonTradingDays: horizon,
        fromDate: null,
        fromClose: null,
        realized: false,
        toDate: null,
        toClose: null,
        forwardReturn: null,
      });
    }

    const target = forwardBars[horizon - 1]!;
    return forwardOutcomeSchema.parse({
      horizonTradingDays: horizon,
      fromDate: query.fromDate,
      fromClose: query.fromClose,
      realized: true,
      toDate: target.tradeDate,
      toClose: target.close,
      forwardReturn: round6((target.close - query.fromClose) / query.fromClose),
    });
  }
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
