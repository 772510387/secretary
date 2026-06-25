import type { AppConfig } from "../config/index.js";
import { isMainBoardSymbol } from "../domain/market/index.js";
import {
  calculatePortfolioValuation,
  roundMoney,
  roundPrice,
  type Account,
  type Position,
} from "../domain/portfolio/index.js";
import type { PlanWatchlistEntry } from "../domain/plan/index.js";
import type { FunnelExecutionConstraints, FunnelOrderCandidate } from "./select-funnel.js";

export interface BuildFunnelExecutionConstraintsInput {
  account: Account;
  positions: Position[];
  watchlist100: PlanWatchlistEntry[];
  prices?: Record<string, number>;
  config: AppConfig;
  maxBuyOrders?: number;
  maxSellOrders?: number;
  maxBuyCandidates?: number;
  cashFraction?: number;
}

const DEFAULT_MAX_BUY_ORDERS = 2;
const DEFAULT_MAX_SELL_ORDERS = 2;
const DEFAULT_MAX_BUY_CANDIDATES = 12;
const DEFAULT_CASH_FRACTION = 0.95;

/**
 * Builds the executable universe before the model sees the funnel.
 *
 * The model may choose side/symbol only from this list. Quantity and price are
 * deterministic backend sizing, based on A-share paper rules:
 * - BUY: main-board only, positive quote, 100-lot, cash, single-position cap.
 * - SELL: currently held and sellable under T+1; odd-lot sells are allowed when
 *   the position itself is an odd remainder.
 */
export function buildFunnelExecutionConstraints(
  input: BuildFunnelExecutionConstraintsInput,
): FunnelExecutionConstraints {
  const maxBuyOrders = Math.max(1, input.maxBuyOrders ?? DEFAULT_MAX_BUY_ORDERS);
  const maxSellOrders = Math.max(1, input.maxSellOrders ?? DEFAULT_MAX_SELL_ORDERS);
  const maxBuyCandidates = Math.max(1, input.maxBuyCandidates ?? DEFAULT_MAX_BUY_CANDIDATES);
  const lotSize = input.config.trading.lotSize;
  const prices = input.prices ?? {};
  const valuation = calculatePortfolioValuation(input.account, input.positions, {
    prices,
    t1Enabled: input.config.trading.t1Enabled,
  });
  const valuationBySymbol = new Map(valuation.positions.map((position) => [position.symbol, position]));
  const buyCashBudget = Math.max(0, input.account.cash.available * (input.cashFraction ?? DEFAULT_CASH_FRACTION));
  const buyCashPerOrder = buyCashBudget / maxBuyOrders;
  const maxSinglePositionValue = valuation.totalAssets * input.config.risk.maxSinglePositionRatio;

  const buyCandidates: FunnelOrderCandidate[] = [];
  for (const entry of sortedWatchlist(input.watchlist100)) {
    if (buyCandidates.length >= maxBuyCandidates) {
      break;
    }
    if (input.config.trading.mainBoardOnly && !isMainBoardSymbol(entry.symbol)) {
      continue;
    }

    const latestPrice = priceFor(entry.symbol, prices, valuationBySymbol);
    if (latestPrice === undefined) {
      continue;
    }

    const existing = valuationBySymbol.get(entry.symbol);
    const currentMarketValue = existing?.marketValue ?? 0;
    const positionRoom = Math.max(0, maxSinglePositionValue - currentMarketValue);
    const budget = Math.min(positionRoom, buyCashPerOrder);
    const maxQuantity = floorToLot(budget / latestPrice, lotSize);

    if (maxQuantity < lotSize) {
      continue;
    }

    buyCandidates.push({
      side: "BUY",
      symbol: entry.symbol,
      market: entry.market,
      name: entry.name,
      latestPrice,
      maxQuantity,
      estimatedAmount: roundMoney(maxQuantity * latestPrice),
      rationale: `rank=${entry.rank ?? "na"}; backend_sized_by_cash_position_lot_board`,
    });
  }

  const sellCandidates: FunnelOrderCandidate[] = [];
  for (const position of valuation.positions) {
    if (position.sellableQuantity <= 0) {
      continue;
    }
    const latestPrice = priceFor(position.symbol, prices, valuationBySymbol);
    if (latestPrice === undefined) {
      continue;
    }
    sellCandidates.push({
      side: "SELL",
      symbol: position.symbol,
      market: position.market,
      name: position.name,
      latestPrice,
      maxQuantity: position.sellableQuantity,
      estimatedAmount: roundMoney(position.sellableQuantity * latestPrice),
      rationale: `sellable=${position.sellableQuantity}; backend_checked_t1`,
    });
  }

  return {
    buyCandidates,
    sellCandidates,
    maxBuyOrders,
    maxSellOrders,
  };
}

function sortedWatchlist(watchlist: PlanWatchlistEntry[]): PlanWatchlistEntry[] {
  return [...watchlist].sort((left, right) => {
    const leftRank = left.rank ?? Number.POSITIVE_INFINITY;
    const rightRank = right.rank ?? Number.POSITIVE_INFINITY;
    return leftRank - rightRank;
  });
}

function priceFor(
  symbol: string,
  prices: Record<string, number>,
  valuationBySymbol: ReadonlyMap<string, { latestPrice: number }>,
): number | undefined {
  const raw = prices[symbol] ?? valuationBySymbol.get(symbol)?.latestPrice;
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return undefined;
  }
  return roundPrice(raw);
}

function floorToLot(quantity: number, lotSize: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0 || lotSize <= 0) {
    return 0;
  }
  return Math.floor(quantity / lotSize) * lotSize;
}
