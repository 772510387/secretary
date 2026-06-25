import { z } from "zod";
import { stockMarketSchema, stockSymbolSchema } from "../shared/index.js";
import { isMainBoardSymbol } from "./symbols.js";

/**
 * One row of the market-wide A-share universe (a real listed stock with its
 * latest snapshot fields). This is what a screener filters/ranks over — the
 * deterministic basis that lets secretary build a stock pool from real data
 * instead of letting the model invent codes.
 */
export const universeStockSchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80),
    latestPrice: z.number().finite().nonnegative().optional(),
    /** Daily change in percent, e.g. 2.34 means +2.34%. */
    changePct: z.number().finite().optional(),
    /** Turnover rate in percent. */
    turnoverRate: z.number().finite().nonnegative().optional(),
    volume: z.number().finite().nonnegative().optional(),
    /** 成交额 in yuan. */
    amount: z.number().finite().nonnegative().optional(),
    /** 总市值 in yuan. */
    marketCap: z.number().finite().nonnegative().optional(),
    /** 所属行业/板块 (e.g. 半导体). Present only from sources that carry it (Eastmoney f100). */
    sector: z.string().trim().min(1).max(40).optional(),
    /** 今日主力净流入额 (yuan, CAN be negative). The 北向 replacement: 聪明钱/主力 flow. Eastmoney f62. */
    mainNetInflow: z.number().finite().optional(),
    /** 今日主力净流入净占比 (%). Eastmoney f184. */
    mainNetInflowRatio: z.number().finite().optional(),
  })
  .strict();

export const screenSortFieldSchema = z.enum([
  "changePct",
  "turnoverRate",
  "amount",
  "marketCap",
  "latestPrice",
]);

export const screenCriteriaSchema = z
  .object({
    /** Project rule: keep only SSE/SZSE main boards. */
    mainBoardOnly: z.boolean().default(true),
    /** Drop ST/*ST/退市 names. */
    excludeST: z.boolean().default(true),
    /** Drop halted rows with no price. */
    requirePrice: z.boolean().default(true),
    minPrice: z.number().nonnegative().optional(),
    maxPrice: z.number().nonnegative().optional(),
    minChangePct: z.number().optional(),
    maxChangePct: z.number().optional(),
    minTurnoverRate: z.number().nonnegative().optional(),
    maxTurnoverRate: z.number().nonnegative().optional(),
    /** Liquidity floor on 成交额 (yuan). */
    minAmount: z.number().nonnegative().optional(),
    minMarketCap: z.number().nonnegative().optional(),
    maxMarketCap: z.number().nonnegative().optional(),
    sortBy: screenSortFieldSchema.default("amount"),
    descending: z.boolean().default(true),
    limit: z.number().int().positive().max(2000).default(100),
  })
  .strict();

export type UniverseStock = z.infer<typeof universeStockSchema>;
export type ScreenSortField = z.infer<typeof screenSortFieldSchema>;
export type ScreenCriteria = z.infer<typeof screenCriteriaSchema>;

/**
 * A hint a universe source can push DOWN to the data API (server-side sort +
 * board filter + how many rows are actually needed) so it fetches a few pages
 * instead of the whole ~5500-stock market. The screener still re-applies all
 * filters locally as the source of truth — this is purely a fetch optimization.
 */
export interface UniverseQuery {
  sortBy?: ScreenSortField;
  descending?: boolean;
  mainBoardOnly?: boolean;
  /** The screen's `limit`; the source fetches ~targetCount × margin rows. */
  targetCount?: number;
}

const ST_PATTERN = /ST|退|^\*/i;

export function isLikelySTName(name: string): boolean {
  return ST_PATTERN.test(name.trim());
}

/**
 * Deterministic filter → rank → top-N over the universe. Pure function: same
 * input, same output. No LLM, no network. Symbols tie-break stably so the pool
 * is reproducible.
 */
export function screenUniverse(
  stocks: readonly UniverseStock[],
  criteriaInput: unknown,
): UniverseStock[] {
  const criteria = screenCriteriaSchema.parse(criteriaInput);
  const filtered = stocks.filter((stock) => passesFilter(stock, criteria));
  const sorted = [...filtered].sort((left, right) =>
    compareBySort(left, right, criteria.sortBy, criteria.descending),
  );
  return sorted.slice(0, criteria.limit);
}

function passesFilter(stock: UniverseStock, criteria: ScreenCriteria): boolean {
  if (criteria.mainBoardOnly && !isMainBoardSymbol(stock.symbol)) {
    return false;
  }

  if (criteria.excludeST && isLikelySTName(stock.name)) {
    return false;
  }

  if (criteria.requirePrice && (stock.latestPrice === undefined || stock.latestPrice <= 0)) {
    return false;
  }

  return (
    withinMin(stock.latestPrice, criteria.minPrice) &&
    withinMax(stock.latestPrice, criteria.maxPrice) &&
    withinMin(stock.changePct, criteria.minChangePct) &&
    withinMax(stock.changePct, criteria.maxChangePct) &&
    withinMin(stock.turnoverRate, criteria.minTurnoverRate) &&
    withinMax(stock.turnoverRate, criteria.maxTurnoverRate) &&
    withinMin(stock.amount, criteria.minAmount) &&
    withinMin(stock.marketCap, criteria.minMarketCap) &&
    withinMax(stock.marketCap, criteria.maxMarketCap)
  );
}

/** A bound is satisfied if unset; if set, the value must exist and meet it. */
function withinMin(value: number | undefined, bound: number | undefined): boolean {
  return bound === undefined || (value !== undefined && value >= bound);
}

function withinMax(value: number | undefined, bound: number | undefined): boolean {
  return bound === undefined || (value !== undefined && value <= bound);
}

function compareBySort(
  left: UniverseStock,
  right: UniverseStock,
  field: ScreenSortField,
  descending: boolean,
): number {
  const leftValue = sortValue(left, field);
  const rightValue = sortValue(right, field);

  if (leftValue === undefined && rightValue === undefined) {
    return left.symbol.localeCompare(right.symbol);
  }
  if (leftValue === undefined) {
    return 1; // missing sorts last
  }
  if (rightValue === undefined) {
    return -1;
  }

  const diff = descending ? rightValue - leftValue : leftValue - rightValue;
  return diff !== 0 ? diff : left.symbol.localeCompare(right.symbol);
}

function sortValue(stock: UniverseStock, field: ScreenSortField): number | undefined {
  switch (field) {
    case "changePct":
      return stock.changePct;
    case "turnoverRate":
      return stock.turnoverRate;
    case "amount":
      return stock.amount;
    case "marketCap":
      return stock.marketCap;
    case "latestPrice":
      return stock.latestPrice;
  }
}

export class ScreenerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenerError";
  }
}
