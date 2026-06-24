import { inferAshareBoard, type AshareBoard } from "./symbols.js";
import type { UniverseStock } from "./screener.js";

/**
 * Deterministic "新题材热度" (market/theme heat) statistics computed purely from a
 * market-wide universe snapshot. This is a 小脑/眼 layer: it turns a raw universe
 * into objective numbers (涨停家数 / 涨跌分布 / 资金集中度 / 热度评分) WITHOUT any
 * model, so the brain is later fed real measured figures instead of inventing
 * them. Every output degrades gracefully — when a needed field (notably
 * `changePct`) is absent it returns null + a note rather than fabricating.
 */
export interface ThemeHeatSummary {
  /** Caller-supplied timestamp this snapshot was computed at; null if not given. */
  asOf: string | null;
  /** Number of rows in the input universe (after no filtering — it's a raw count). */
  universeSize: number;
  /** 涨停家数. null when no row carries `changePct` (cannot be computed honestly). */
  limitUpCount: number | null;
  /** 跌停家数. null when `changePct` is unavailable across the universe. */
  limitDownCount: number | null;
  /** 上涨家数 (changePct > 0). null when `changePct` is unavailable. */
  advancers: number | null;
  /** 下跌家数 (changePct < 0). null when `changePct` is unavailable. */
  decliners: number | null;
  /** Up to N strongest names by changePct desc (only rows that have changePct). */
  topGainers: Array<{ symbol: string; name: string; changePct: number }>;
  /** Up to N names by 成交额 desc — a proxy for 资金热度 (only rows that have amount). */
  topByAmount: Array<{ symbol: string; name: string; amount: number }>;
  /** 0..100 deterministic composite. 0 when the inputs needed are missing. */
  heatScore: number;
  /** True when any required field was missing and a metric had to be skipped. */
  degraded: boolean;
  /** Human-readable reasons for any degradation (so the brain knows what's absent). */
  notes: string[];
}

export interface ComputeThemeHeatOptions {
  /**
   * Injected "now" used to stamp `asOf`. Keeping the clock injectable preserves
   * purity/determinism — the function never calls Date.now() itself.
   */
  now?: string;
  /** How many rows to keep in topGainers / topByAmount. Defaults to 10. */
  topN?: number;
}

export class ThemeHeatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThemeHeatError";
  }
}

const DEFAULT_TOP_N = 10;

/**
 * Per-board 涨停/跌停 thresholds in PERCENT (changePct is a percent, e.g. 9.97 =
 * +9.97% — confirmed by universeStockSchema's doc comment). Real prints land
 * slightly under the nominal cap (9.97/9.98, 19.94/19.96) because of price
 * tick rounding, so we use a small tolerance below the nominal cap rather than
 * an exact == that would miss genuine limit moves:
 *   主板 (sse_main / szse_main): ±10%  -> count at |changePct| >= 9.8
 *   科创/创业 (star / chinext):  ±20%  -> count at |changePct| >= 19.5
 *   其他 (e.g. 北交所/BSE):       ±30%  -> count at |changePct| >= 29.5
 */
function limitThresholdForBoard(board: AshareBoard): number {
  switch (board) {
    case "sse_main":
    case "szse_main":
      return 9.8;
    case "star":
    case "chinext":
      return 19.5;
    case "other":
    default:
      // 北交所 has a 30% cap; treat unknown boards conservatively at the same band.
      return 29.5;
  }
}

export type LimitState = "limit_up" | "limit_down" | "normal" | "unknown";

/**
 * Classify a stock's limit-board state from its (percent) changePct, using the same
 * per-board thresholds as the heat counts. Returns "unknown" when changePct is absent
 * (we never guess a 涨停/跌停 without data). This is the deterministic 涨停/跌停 signal the
 * 100池 carries per the spec — NOT a true 一字板 (which needs open=high=low order-book data
 * we don't have) and NOT 封单 (no order-book source at all).
 */
export function classifyLimitState(symbol: string, changePct: number | undefined): LimitState {
  if (!isFiniteNumber(changePct)) {
    return "unknown";
  }
  const threshold = limitThresholdForBoard(inferAshareBoard(symbol));
  if (changePct >= threshold) {
    return "limit_up";
  }
  if (changePct <= -threshold) {
    return "limit_down";
  }
  return "normal";
}

/** Number guard: only finite numbers count as "present" for a metric. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Compute objective theme/market heat from a universe snapshot. Pure and
 * deterministic: same input + same options -> same output. No I/O, no network,
 * no clock access. An empty universe yields a fully-degraded summary (counts
 * null, heatScore 0) and never throws.
 */
export function computeThemeHeat(
  universe: readonly UniverseStock[],
  options: ComputeThemeHeatOptions = {},
): ThemeHeatSummary {
  // Validate the only free-form numeric option up front. We throw on a clearly
  // invalid topN (non-positive / non-integer) because a silent fallback would
  // hide a caller bug; everything else degrades rather than throws.
  const topN = options.topN ?? DEFAULT_TOP_N;
  if (!Number.isInteger(topN) || topN <= 0) {
    throw new ThemeHeatError(`topN must be a positive integer, received ${String(options.topN)}`);
  }

  const asOf = options.now ?? null;
  const universeSize = universe.length;
  const notes: string[] = [];

  // Empty universe: nothing to measure. Degrade fully but stay valid.
  if (universeSize === 0) {
    notes.push("universe 为空，所有热度指标不可计算");
    return {
      asOf,
      universeSize: 0,
      limitUpCount: null,
      limitDownCount: null,
      advancers: null,
      decliners: null,
      topGainers: [],
      topByAmount: [],
      heatScore: 0,
      degraded: true,
      notes,
    };
  }

  // --- changePct-derived metrics (涨跌分布 / 涨停家数 / 跌停家数) ---
  // These are only honest when at least one row carries changePct; otherwise we
  // return null + a note instead of pretending the count is zero.
  const withChange = universe.filter((stock) => isFiniteNumber(stock.changePct));
  const hasChange = withChange.length > 0;

  let limitUpCount: number | null = null;
  let limitDownCount: number | null = null;
  let advancers: number | null = null;
  let decliners: number | null = null;

  if (hasChange) {
    limitUpCount = 0;
    limitDownCount = 0;
    advancers = 0;
    decliners = 0;

    for (const stock of withChange) {
      const changePct = stock.changePct as number;
      const threshold = limitThresholdForBoard(inferAshareBoard(stock.symbol));

      if (changePct >= threshold) {
        limitUpCount += 1;
      } else if (changePct <= -threshold) {
        limitDownCount += 1;
      }

      if (changePct > 0) {
        advancers += 1;
      } else if (changePct < 0) {
        decliners += 1;
      }
      // changePct === 0 (平盘) counts as neither advancer nor decliner.
    }

    // Flag partial coverage: some rows lacked changePct so the counts are a
    // floor over the rows that had it, not the whole universe.
    if (withChange.length < universeSize) {
      notes.push(
        `${universeSize - withChange.length}/${universeSize} 只缺少 changePct，涨跌/涨停统计基于有数据的 ${withChange.length} 只`,
      );
    }
  } else {
    notes.push("changePct 字段缺失，涨停/跌停/涨跌家数不可计算");
  }

  // --- topGainers (by changePct desc) ---
  // Stable tie-break on symbol so the ranking is reproducible.
  const topGainers = [...withChange]
    .sort((left, right) => {
      const diff = (right.changePct as number) - (left.changePct as number);
      return diff !== 0 ? diff : left.symbol.localeCompare(right.symbol);
    })
    .slice(0, topN)
    .map((stock) => ({
      symbol: stock.symbol,
      name: stock.name,
      changePct: stock.changePct as number,
    }));

  // --- topByAmount (by 成交额 desc) — proxy for 资金热度 ---
  const withAmount = universe.filter((stock) => isFiniteNumber(stock.amount));
  if (withAmount.length === 0) {
    notes.push("amount 字段缺失，资金热度(topByAmount)不可计算");
  }
  const topByAmount = [...withAmount]
    .sort((left, right) => {
      const diff = (right.amount as number) - (left.amount as number);
      return diff !== 0 ? diff : left.symbol.localeCompare(right.symbol);
    })
    .slice(0, topN)
    .map((stock) => ({
      symbol: stock.symbol,
      name: stock.name,
      amount: stock.amount as number,
    }));

  // --- heatScore: deterministic 0..100 composite ---
  const heatScore = computeHeatScore({
    universeSize,
    withChange: withChange.length,
    limitUpCount,
    advancers,
    decliners,
    amounts: withAmount.map((stock) => stock.amount as number),
  });

  // Degraded when anything had to be skipped or only partially computed.
  const degraded = notes.length > 0;

  return {
    asOf,
    universeSize,
    limitUpCount,
    limitDownCount,
    advancers,
    decliners,
    topGainers,
    topByAmount,
    heatScore,
    degraded,
    notes,
  };
}

interface HeatScoreInputs {
  universeSize: number;
  withChange: number;
  limitUpCount: number | null;
  advancers: number | null;
  decliners: number | null;
  amounts: number[];
}

/**
 * Blend three objective sub-signals into a single 0..100 heat reading. Each
 * sub-signal is normalised to 0..1, then weighted. Sub-signals whose inputs are
 * missing contribute 0 and their weight is dropped from the denominator, so a
 * universe with no changePct still yields a meaningful (turnover-only) score
 * rather than a misleadingly low one — and a universe with NO usable inputs at
 * all scores exactly 0.
 *
 *   limit-up density   (weight 0.4): 涨停家数 / universeSize, scaled so ~5% of the
 *                                    market at limit-up reads as full heat.
 *   advance ratio      (weight 0.4): advancers / (advancers + decliners), i.e.
 *                                    breadth of the up-move.
 *   turnover concentration (weight 0.2): share of total 成交额 held by the top
 *                                    decile of names — high concentration =
 *                                    money crowding into a hot theme.
 */
function computeHeatScore(inputs: HeatScoreInputs): number {
  const parts: Array<{ value: number; weight: number }> = [];

  if (inputs.limitUpCount !== null && inputs.universeSize > 0) {
    // 5% of the universe at limit-up saturates this sub-signal.
    const density = inputs.limitUpCount / inputs.universeSize;
    const saturated = Math.min(1, density / 0.05);
    parts.push({ value: saturated, weight: 0.4 });
  }

  if (inputs.advancers !== null && inputs.decliners !== null) {
    const breadthBase = inputs.advancers + inputs.decliners;
    if (breadthBase > 0) {
      parts.push({ value: inputs.advancers / breadthBase, weight: 0.4 });
    }
  }

  if (inputs.amounts.length > 0) {
    parts.push({ value: turnoverConcentration(inputs.amounts), weight: 0.2 });
  }

  if (parts.length === 0) {
    return 0;
  }

  const weightedSum = parts.reduce((sum, part) => sum + part.value * part.weight, 0);
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const normalised = weightedSum / totalWeight; // 0..1

  // Round to keep the score stable/readable; deterministic for equal inputs.
  return Math.round(normalised * 100);
}

/**
 * Fraction of total 成交额 captured by the top decile (at least 1) of names.
 * Returns 0..1; higher means money is concentrated (a hot theme), lower means
 * it is spread evenly across the market.
 */
function turnoverConcentration(amounts: number[]): number {
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  if (total <= 0) {
    return 0;
  }
  const topCount = Math.max(1, Math.ceil(amounts.length * 0.1));
  const topSum = [...amounts]
    .sort((left, right) => right - left)
    .slice(0, topCount)
    .reduce((sum, amount) => sum + amount, 0);
  return topSum / total;
}
