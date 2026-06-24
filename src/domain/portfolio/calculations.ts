import type { Account, Position } from "./schemas.js";

export const MONEY_DECIMALS = 2;
export const PRICE_DECIMALS = 4;
export const RATIO_DECIMALS = 6;

export interface CashSummary {
  available: number;
  frozen: number;
  total: number;
}

export interface PositionValuation {
  accountId: string;
  symbol: string;
  market: Position["market"];
  name: string;
  quantity: number;
  sellableQuantity: number;
  t1AvailableQuantity: number;
  frozenQuantity: number;
  todayBuyQuantity: number;
  costPrice: number;
  latestPrice: number;
  costBasis: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlRatio: number;
  positionRatio: number;
}

export interface PortfolioValuation {
  accountId: string;
  cash: CashSummary;
  positions: PositionValuation[];
  totalPositionMarketValue: number;
  totalCostBasis: number;
  totalUnrealizedPnl: number;
  totalAssets: number;
  investedRatio: number;
}

export interface QuantityAvailabilityOptions {
  t1Enabled?: boolean;
}

export interface PositionValuationOptions extends QuantityAvailabilityOptions {
  latestPrice?: number;
  totalAssets?: number;
}

export interface PortfolioValuationOptions extends QuantityAvailabilityOptions {
  prices?: Record<string, number>;
}

export interface AverageCostInput {
  existingQuantity: number;
  existingCostPrice: number;
  buyQuantity: number;
  buyPrice: number;
  buyFees?: number;
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const epsilon = Number.EPSILON * Math.sign(value || 1);
  return Math.round((value + epsilon) * factor) / factor;
}

export function roundMoney(value: number): number {
  return roundTo(value, MONEY_DECIMALS);
}

export function roundPrice(value: number): number {
  return roundTo(value, PRICE_DECIMALS);
}

export function roundRatio(value: number): number {
  return roundTo(value, RATIO_DECIMALS);
}

export function calculateCashSummary(account: Account): CashSummary {
  const available = roundMoney(account.cash.available);
  const frozen = roundMoney(account.cash.frozen);

  return {
    available,
    frozen,
    total: roundMoney(available + frozen),
  };
}

export function calculateCostBasis(position: Position): number {
  return roundMoney(position.quantity * position.costPrice);
}

export function calculateMarketValue(position: Position, latestPrice = position.latestPrice ?? 0): number {
  return roundMoney(position.quantity * latestPrice);
}

export function calculateUnrealizedPnl(position: Position, latestPrice = position.latestPrice ?? 0): number {
  return roundMoney(calculateMarketValue(position, latestPrice) - calculateCostBasis(position));
}

export function calculateUnrealizedPnlRatio(
  position: Position,
  latestPrice = position.latestPrice ?? 0,
): number {
  const costBasis = calculateCostBasis(position);

  if (costBasis === 0) {
    return 0;
  }

  return roundRatio(calculateUnrealizedPnl(position, latestPrice) / costBasis);
}

export function calculateT1AvailableQuantity(
  position: Position,
  options: QuantityAvailabilityOptions = {},
): number {
  const t1Enabled = options.t1Enabled !== false;
  const blockedByT1 = t1Enabled ? position.todayBuyQuantity : 0;
  return Math.max(0, position.quantity - blockedByT1 - position.frozenQuantity);
}

export function calculateSellableQuantity(
  position: Position,
  options: QuantityAvailabilityOptions = {},
): number {
  return Math.max(
    0,
    Math.min(position.availableQuantity, calculateT1AvailableQuantity(position, options)),
  );
}

/**
 * T+1 cross-day rollover (the missing settlement step): once the trading date has
 * advanced PAST the buy date, the shares locked as todayBuyQuantity settle and become
 * available to sell. Pure and idempotent — returns the SAME object when nothing changes.
 *
 * - A position with no todayBuyQuantity is returned untouched.
 * - lastBuyTradeDate absent: the lot is undateable, so we conservatively leave it locked
 *   (never auto-unlock something we can't prove is from a prior day). New buys always stamp
 *   the date, so going forward every lot settles correctly.
 * - lastBuyTradeDate >= tradingDate means the lock still applies today → untouched.
 * - lastBuyTradeDate < tradingDate → the T+1 lock has expired, shares settle to available.
 */
export function rollForwardPositionForTradingDate(position: Position, tradingDate: string): Position {
  if (position.todayBuyQuantity <= 0) {
    return position;
  }
  if (position.lastBuyTradeDate === undefined || position.lastBuyTradeDate >= tradingDate) {
    return position;
  }
  const { lastBuyTradeDate: _settled, ...rest } = position;
  return {
    ...rest,
    availableQuantity: Math.max(0, position.quantity - position.frozenQuantity),
    todayBuyQuantity: 0,
  };
}

export function rollForwardPositionsForTradingDate(
  positions: readonly Position[],
  tradingDate: string,
): { positions: Position[]; changed: number } {
  let changed = 0;
  const rolled = positions.map((position) => {
    const next = rollForwardPositionForTradingDate(position, tradingDate);
    if (next !== position) {
      changed += 1;
    }
    return next;
  });
  return { positions: rolled, changed };
}

export function calculateAverageCostAfterBuy(input: AverageCostInput): number {
  assertNonNegativeInteger(input.existingQuantity, "existingQuantity");
  assertNonNegativeNumber(input.existingCostPrice, "existingCostPrice");
  assertPositiveInteger(input.buyQuantity, "buyQuantity");
  assertPositiveNumber(input.buyPrice, "buyPrice");
  assertNonNegativeNumber(input.buyFees ?? 0, "buyFees");

  const totalQuantity = input.existingQuantity + input.buyQuantity;

  if (totalQuantity <= 0) {
    throw new PortfolioCalculationError("totalQuantity must be positive");
  }

  const existingCost = input.existingQuantity * input.existingCostPrice;
  const buyCost = input.buyQuantity * input.buyPrice + (input.buyFees ?? 0);

  return roundPrice((existingCost + buyCost) / totalQuantity);
}

export function calculateRealizedCost(quantity: number, costPrice: number): number {
  assertPositiveInteger(quantity, "quantity");
  assertNonNegativeNumber(costPrice, "costPrice");
  return roundMoney(quantity * costPrice);
}

export function calculatePositionValuation(
  position: Position,
  options: PositionValuationOptions = {},
): PositionValuation {
  const latestPrice = options.latestPrice ?? position.latestPrice ?? 0;
  const costBasis = calculateCostBasis(position);
  const marketValue = calculateMarketValue(position, latestPrice);
  const unrealizedPnl = roundMoney(marketValue - costBasis);
  const totalAssets = options.totalAssets ?? 0;

  return {
    accountId: position.accountId,
    symbol: position.symbol,
    market: position.market,
    name: position.name,
    quantity: position.quantity,
    sellableQuantity: calculateSellableQuantity(position, options),
    t1AvailableQuantity: calculateT1AvailableQuantity(position, options),
    frozenQuantity: position.frozenQuantity,
    todayBuyQuantity: position.todayBuyQuantity,
    costPrice: roundPrice(position.costPrice),
    latestPrice: roundPrice(latestPrice),
    costBasis,
    marketValue,
    unrealizedPnl,
    unrealizedPnlRatio: costBasis === 0 ? 0 : roundRatio(unrealizedPnl / costBasis),
    positionRatio: totalAssets > 0 ? roundRatio(marketValue / totalAssets) : 0,
  };
}

export function calculatePortfolioValuation(
  account: Account,
  positions: Position[],
  options: PortfolioValuationOptions = {},
): PortfolioValuation {
  const cash = calculateCashSummary(account);
  const firstPassPositions = positions.map((position) =>
    calculatePositionValuation(position, {
      t1Enabled: options.t1Enabled,
      latestPrice: options.prices?.[position.symbol],
    }),
  );
  const totalPositionMarketValue = roundMoney(
    firstPassPositions.reduce((sum, position) => sum + position.marketValue, 0),
  );
  const totalAssets = roundMoney(cash.total + totalPositionMarketValue);
  const valuedPositions = positions.map((position) =>
    calculatePositionValuation(position, {
      t1Enabled: options.t1Enabled,
      latestPrice: options.prices?.[position.symbol],
      totalAssets,
    }),
  );
  const totalCostBasis = roundMoney(
    valuedPositions.reduce((sum, position) => sum + position.costBasis, 0),
  );
  const totalUnrealizedPnl = roundMoney(
    valuedPositions.reduce((sum, position) => sum + position.unrealizedPnl, 0),
  );

  return {
    accountId: account.accountId,
    cash,
    positions: valuedPositions,
    totalPositionMarketValue,
    totalCostBasis,
    totalUnrealizedPnl,
    totalAssets,
    investedRatio: totalAssets > 0 ? roundRatio(totalPositionMarketValue / totalAssets) : 0,
  };
}

export class PortfolioCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortfolioCalculationError";
  }
}

function assertNonNegativeNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new PortfolioCalculationError(`${name} must be a non-negative number`);
  }
}

function assertPositiveNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PortfolioCalculationError(`${name} must be a positive number`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new PortfolioCalculationError(`${name} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new PortfolioCalculationError(`${name} must be a positive integer`);
  }
}

