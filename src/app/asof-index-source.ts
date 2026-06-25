import {
  sortKlineBars,
  type IndexId,
  type KlineBar,
  type StockSymbolInfo,
} from "../domain/market/index.js";
import type { HistoryProvider } from "../infrastructure/providers/index.js";
import type { AsOfIndex, AsOfIndexSource } from "./asof-market-reader.js";

export interface KlineAsOfIndexSourceOptions {
  historyProvider: HistoryProvider;
  count?: number;
  indexes?: readonly AsOfIndexDefinition[];
}

export interface AsOfIndexDefinition {
  indexId: IndexId;
  code: string;
  market: "SSE" | "SZSE";
  name: string;
}

const DEFAULT_INDEX_HISTORY_COUNT = 80;

export const DEFAULT_ASOF_INDEX_DEFINITIONS: readonly AsOfIndexDefinition[] = [
  { indexId: "sse_composite", code: "000001", market: "SSE", name: "上证综指" },
  { indexId: "szse_component", code: "399001", market: "SZSE", name: "深证成指" },
  { indexId: "chinext", code: "399006", market: "SZSE", name: "创业板指" },
  { indexId: "star50", code: "000688", market: "SSE", name: "科创50" },
];

/**
 * As-of index reader for faithful replay. It derives index closes from daily K
 * lines bounded to the replay date, so a historical replay never falls back to
 * today's live index snapshot.
 */
export class KlineAsOfIndexSource implements AsOfIndexSource {
  private readonly historyProvider: HistoryProvider;
  private readonly count: number;
  private readonly indexes: readonly AsOfIndexDefinition[];

  constructor(options: KlineAsOfIndexSourceOptions) {
    this.historyProvider = options.historyProvider;
    this.count = options.count ?? DEFAULT_INDEX_HISTORY_COUNT;
    this.indexes = options.indexes ?? DEFAULT_ASOF_INDEX_DEFINITIONS;
  }

  async getIndicesAsOf(asOfDate: string, inclusive: boolean): Promise<AsOfIndex[]> {
    const settled = await Promise.all(
      this.indexes.map((definition) => this.readOneIndex(definition, asOfDate, inclusive)),
    );

    return settled.filter((index): index is AsOfIndex => index !== undefined);
  }

  private async readOneIndex(
    definition: AsOfIndexDefinition,
    asOfDate: string,
    inclusive: boolean,
  ): Promise<AsOfIndex | undefined> {
    try {
      const raw = await this.historyProvider.getDailyKlines(toSymbolInfo(definition), {
        endDate: asOfDate,
        count: this.count + 1,
      });
      const surviving = sortKlineBars(raw)
        .filter((bar) => (inclusive ? bar.tradeDate <= asOfDate : bar.tradeDate < asOfDate))
        .slice(-this.count);
      const latest = surviving[surviving.length - 1];

      if (!latest) {
        return undefined;
      }

      const previous = findPreviousBar(surviving, latest);
      const changePct =
        previous && previous.close > 0 ? roundRatio((latest.close - previous.close) / previous.close) : 0;

      return {
        indexId: definition.indexId,
        name: definition.name,
        latestPrice: latest.close,
        changePct,
        asOfDate: latest.tradeDate,
      };
    } catch {
      return undefined;
    }
  }
}

function toSymbolInfo(definition: AsOfIndexDefinition): StockSymbolInfo {
  return {
    symbol: definition.code,
    market: definition.market,
    name: definition.name,
  };
}

function findPreviousBar(bars: readonly KlineBar[], latest: KlineBar): KlineBar | undefined {
  for (let index = bars.length - 2; index >= 0; index -= 1) {
    const candidate = bars[index];
    if (candidate && candidate.tradeDate < latest.tradeDate) {
      return candidate;
    }
  }

  return undefined;
}

function roundRatio(value: number): number {
  const factor = 1_000_000;
  const epsilon = Number.EPSILON * Math.sign(value || 1);
  return Math.round((value + epsilon) * factor) / factor;
}
