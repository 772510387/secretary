import {
  calculatePortfolioValuation,
  pointInTimeSnapshotSchema,
  type Account,
  type PointInTimeSnapshot,
  type Position,
  type SnapshotPriceSource,
} from "../domain/portfolio/index.js";
import type { StockSymbolInfo } from "../domain/market/index.js";
import { buildAskContext, type AskTechnical } from "./ask-portfolio.js";
import { AsOfMarketReader } from "./asof-market-reader.js";

export interface BuildReplaySnapshotInput {
  alarmId: string;
  alarmType: string;
  jobId: string;
  /** HH:MM Beijing wall time of the node. */
  beijingTime: string;
  asOfDate: string;
  /** ISO-8601 UTC instant (must be `...Z`). */
  asOfTime: string;
  /** Whether the same trading day's bar is treated as settled (post-close nodes). */
  sameDayBarIncluded: boolean;
  account: Account;
  positions: Position[];
  reader: AsOfMarketReader;
  historyCount?: number;
  reason?: "replay" | "daily_close" | "manual";
}

/**
 * Assembles ONE point-in-time snapshot for a (date, node) — the exact bundle the
 * brain would have seen, bounded to `asOfTime`, with no model call.
 *
 * No-look-ahead is enforced at three layers: the reader filters bars to `<= asOfDate`;
 * this builder strips each position's on-disk `latestPrice` so mark-to-market can
 * ONLY use an as-of bar close (degraded symbols are explicitly valued at cost, never
 * via a stale price); and `pointInTimeSnapshotSchema.parse` rejects any residual leak.
 */
export async function buildReplaySnapshot(
  input: BuildReplaySnapshotInput,
): Promise<PointInTimeSnapshot> {
  const symbols: StockSymbolInfo[] = input.positions.map((position) => ({
    symbol: position.symbol,
    market: position.market,
    name: position.name,
  }));

  const market = await input.reader.buildAsOfMarketContext({
    symbols,
    asOfDate: input.asOfDate,
    inclusive: input.sameDayBarIncluded,
    count: input.historyCount,
  });

  // Strip on-disk latestPrice: a degraded symbol must never silently mark-to-market
  // against a stale price baked into the position record (the look-ahead leak the
  // critic flagged). Held symbols with no as-of bar are valued explicitly at cost.
  const positionsAsOf: Position[] = input.positions.map((position) => {
    const stripped = { ...position };
    delete stripped.latestPrice;
    return stripped;
  });

  const prices: Record<string, number> = {};
  const priceSources: Record<string, SnapshotPriceSource> = {};
  const costFallbackReasons: string[] = [];

  for (const position of positionsAsOf) {
    const asOfPrice = market.prices[position.symbol];
    if (asOfPrice !== undefined) {
      prices[position.symbol] = asOfPrice;
      priceSources[position.symbol] = market.priceSources[position.symbol]!;
    } else {
      prices[position.symbol] = position.costPrice;
      priceSources[position.symbol] = { source: "cost_fallback" };
      costFallbackReasons.push(`${position.symbol}: valued at cost (no as-of bar)`);
    }
  }

  const valuation = calculatePortfolioValuation(input.account, positionsAsOf, {
    prices,
    t1Enabled: true,
  });

  const technicals: AskTechnical[] = market.technicals;
  const brainContext = buildAskContext({
    valuation,
    pricesAvailable: market.pricesAvailable,
    asOf: input.asOfTime,
    technicals,
    indices: market.indices,
  });

  const snapshotId = `snap-${input.alarmId}-${input.asOfDate.replace(/-/g, "")}-${input.beijingTime.replace(":", "")}`;
  const degradedReasons = [...market.degradedReasons, ...costFallbackReasons];

  return pointInTimeSnapshotSchema.parse({
    schemaVersion: 1,
    snapshotId,
    accountId: input.account.accountId,
    alarmId: input.alarmId,
    alarmType: input.alarmType,
    jobId: input.jobId,
    asOfDate: input.asOfDate,
    asOfTime: input.asOfTime,
    beijingTime: input.beijingTime,
    sameDayBarIncluded: input.sameDayBarIncluded,
    account: input.account,
    positions: positionsAsOf,
    valuation,
    market: {
      pricesAvailable: market.pricesAvailable,
      prices,
      priceSources,
      technicals: technicals.map((technical) => ({
        symbol: technical.symbol,
        market: technical.market,
        name: technical.name ?? null,
        asOfDate: technical.asOfDate,
        trend: technical.trend,
        ma5: technical.ma5 ?? null,
        ma10: technical.ma10 ?? null,
        ma20: technical.ma20 ?? null,
        high60: technical.high60,
        low60: technical.low60,
        rangePosition60: technical.rangePosition60,
      })),
      indices: market.indices.map((index) => ({
        name: index.name,
        latestPrice: index.latestPrice,
        changePct: index.changePct,
        asOfDate: index.asOfDate,
      })),
    },
    brainContext,
    metadata: {
      reason: input.reason ?? "replay",
      version: 1,
      generatedBy: "replay-runner",
      degraded: degradedReasons.length > 0,
      degradedReasons,
      historyAsOfDates: market.historyAsOfDates,
      indicesAvailable: market.indices.length > 0,
      calendar: "weekday_only",
    },
  });
}
