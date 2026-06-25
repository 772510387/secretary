import { classifyLimitState } from "./theme-heat.js";
import { isLikelySTName, type UniverseStock } from "./screener.js";
import { renderSealTag, type SealBoard } from "./seal-board.js";
import { isMainBoardSymbol } from "./symbols.js";

/**
 * The OpenClaw-style observation-pool buckets. Each pool stock is assigned ONE
 * primary bucket (the most informative one it qualifies for), so a 100-pool is a
 * categorized set — 持仓 / 涨停 / 跌停 / 涨幅榜 / 成交额榜 — instead of one flat
 * turnover ranking. `hot_sector_leader` (needs sector data) is intentionally NOT
 * produced here yet; see pool-categories docs for the deferred sector source.
 */
export type PoolBucket =
  | "position"
  | "limit_up"
  | "limit_down"
  | "yesterday_limit_up"
  | "yesterday_limit_down"
  | "hot_sector_leader"
  | "change_top"
  | "amount_top";

/** Priority order when a stock qualifies for several buckets (first match wins). */
const BUCKET_PRIORITY: readonly PoolBucket[] = [
  "position",
  "limit_up",
  "limit_down",
  "yesterday_limit_up",
  "yesterday_limit_down",
  "hot_sector_leader",
  "change_top",
  "amount_top",
];

export const POOL_BUCKET_LABEL: Record<PoolBucket, string> = {
  position: "持仓股",
  limit_up: "涨停",
  limit_down: "跌停",
  yesterday_limit_up: "昨日涨停",
  yesterday_limit_down: "昨日跌停",
  hot_sector_leader: "热门板块龙头",
  change_top: "涨幅榜",
  amount_top: "成交额榜",
};

/** A stock counts as "strong" for hot-sector detection at/above this 涨跌幅. */
const HOT_SECTOR_STRONG_PCT = 5;
/** A sector is "hot" when it has at least this many strong names today. */
const HOT_SECTOR_MIN_STRONG = 2;

export interface CategorizedPoolEntry {
  stock: UniverseStock;
  bucket: PoolBucket;
  /** 1-based rank WITHIN the bucket (by the bucket's own ordering). */
  rankInBucket: number;
}

export interface CategorizeUniverseOptions {
  /** Held symbols (digits only); always kept as `position`, even if absent from the universe screen. */
  heldSymbols?: readonly string[];
  /** Optional names for held symbols not present in the universe (so positions still render). */
  heldNames?: Readonly<Record<string, string>>;
  /** Symbols that were limit-up on the PRIOR trading day (continuation/连板 watch). */
  yesterdayLimitUpSymbols?: readonly string[];
  /** Symbols that were limit-down on the PRIOR trading day (rebound/补跌 watch). */
  yesterdayLimitDownSymbols?: readonly string[];
  limitUpTarget?: number;
  limitDownTarget?: number;
  /** 热门板块龙头 count (needs sector data; 0 disables). */
  hotSectorLeaderTarget?: number;
  changeTopTarget?: number;
  amountTopTarget?: number;
  /** Liquidity floor (yuan 成交额) applied to change_top / amount_top (not to limit boards / positions). */
  minAmount?: number;
  /** Hard cap on the total pool size (positions are never dropped by the cap). */
  maxTotal?: number;
}

const DEFAULTS = {
  limitUpTarget: 30,
  limitDownTarget: 20,
  hotSectorLeaderTarget: 10,
  changeTopTarget: 20,
  minAmount: 0,
  maxTotal: 100,
} as const;

/**
 * Pure, deterministic categorizer: filter the universe to tradable main-board
 * non-ST priced names, then derive the buckets and assign each surviving stock a
 * single primary bucket by {@link BUCKET_PRIORITY}. Same input → same output;
 * symbols tie-break stably so the pool is reproducible. No LLM, no network.
 */
export function categorizeUniverse(
  universe: readonly UniverseStock[],
  options: CategorizeUniverseOptions = {},
): CategorizedPoolEntry[] {
  const limitUpTarget = options.limitUpTarget ?? DEFAULTS.limitUpTarget;
  const limitDownTarget = options.limitDownTarget ?? DEFAULTS.limitDownTarget;
  const changeTopTarget = options.changeTopTarget ?? DEFAULTS.changeTopTarget;
  const minAmount = options.minAmount ?? DEFAULTS.minAmount;
  const maxTotal = options.maxTotal ?? DEFAULTS.maxTotal;
  const heldSymbols = new Set((options.heldSymbols ?? []).map((symbol) => symbol.trim()));

  // Tradable, real, priced rows only — the same constitution the screener enforces.
  const tradable = universe.filter(
    (stock) =>
      isMainBoardSymbol(stock.symbol) &&
      !isLikelySTName(stock.name) &&
      stock.latestPrice !== undefined &&
      stock.latestPrice > 0,
  );
  const bySymbol = new Map(tradable.map((stock) => [stock.symbol, stock] as const));

  const assigned = new Set<string>();
  const result: CategorizedPoolEntry[] = [];

  const take = (
    bucket: PoolBucket,
    candidates: readonly UniverseStock[],
    target: number,
  ): void => {
    let rankInBucket = 0;
    for (const stock of candidates) {
      if (rankInBucket >= target) {
        break;
      }
      if (assigned.has(stock.symbol)) {
        continue;
      }
      assigned.add(stock.symbol);
      rankInBucket += 1;
      result.push({ stock, bucket, rankInBucket });
    }
  };

  // 1. 持仓股 — always first, never dropped by the cap. Use universe row when known,
  //    else a minimal synthetic row (name only) so the holding still appears.
  let positionRank = 0;
  for (const symbol of heldSymbols) {
    const stock =
      bySymbol.get(symbol) ??
      ({
        symbol,
        market: symbol.startsWith("6") ? "SSE" : "SZSE",
        name: options.heldNames?.[symbol] ?? symbol,
      } as UniverseStock);
    if (assigned.has(symbol)) {
      continue;
    }
    assigned.add(symbol);
    positionRank += 1;
    result.push({ stock, bucket: "position", rankInBucket: positionRank });
  }

  // 2. 涨停 / 跌停 — today's limit boards (derived from changePct), strongest by 成交额.
  const limitUp = tradable
    .filter((stock) => classifyLimitState(stock.symbol, stock.changePct) === "limit_up")
    .sort(byAmountDesc);
  take("limit_up", limitUp, limitUpTarget);

  const limitDown = tradable
    .filter((stock) => classifyLimitState(stock.symbol, stock.changePct) === "limit_down")
    .sort(byAmountDesc);
  take("limit_down", limitDown, limitDownTarget);

  // 2b. 昨日涨停/跌停 — carried over from the prior trading day's close snapshot, so today's
  //     pool watches continuation (连板) and rebound plays even if they aren't moving yet.
  const yesterdayUp = new Set((options.yesterdayLimitUpSymbols ?? []).map((symbol) => symbol.trim()));
  const yesterdayDown = new Set((options.yesterdayLimitDownSymbols ?? []).map((symbol) => symbol.trim()));
  take(
    "yesterday_limit_up",
    tradable.filter((stock) => yesterdayUp.has(stock.symbol)).sort(byAmountDesc),
    yesterdayUp.size,
  );
  take(
    "yesterday_limit_down",
    tradable.filter((stock) => yesterdayDown.has(stock.symbol)).sort(byAmountDesc),
    yesterdayDown.size,
  );

  // 2c. 热门板块龙头 — the highest-成交额 name of each sector that is running hot today
  //     (≥2 strong names). Needs sector data (Eastmoney f100); silently empty without it.
  const hotSectorLeaderTarget = options.hotSectorLeaderTarget ?? DEFAULTS.hotSectorLeaderTarget;
  if (hotSectorLeaderTarget > 0) {
    take("hot_sector_leader", findSectorLeaders(tradable), hotSectorLeaderTarget);
  }

  // 3. 涨幅榜 — biggest gainers not already on a limit board, liquidity-floored.
  const changeTop = tradable
    .filter((stock) => stock.changePct !== undefined && passesAmount(stock, minAmount))
    .sort((left, right) => byNumberDesc(left.changePct, right.changePct, left, right));
  take("change_top", changeTop, changeTopTarget);

  // 4. 成交额榜 — the filler: most-traded names not already captured, topping the
  //    pool up toward maxTotal. On a calm day (few limit boards) this is most of the
  //    pool; when an explicit amountTopTarget is given it is honored as a cap instead.
  const amountTop = tradable
    .filter((stock) => passesAmount(stock, minAmount))
    .sort(byAmountDesc);
  const amountRoom = Math.max(0, maxTotal - result.length);
  take("amount_top", amountTop, options.amountTopTarget ?? amountRoom);

  return capPool(result, maxTotal);
}

/**
 * Returns one 龙头 per "hot" sector (a sector with ≥2 strong names today), ordered by
 * sector heat then leader 成交额. The leader is the sector's highest-成交额 name — the one
 * with the most capital consensus. Empty when no rows carry sector data.
 */
function findSectorLeaders(tradable: readonly UniverseStock[]): UniverseStock[] {
  const bySector = new Map<string, UniverseStock[]>();
  for (const stock of tradable) {
    if (stock.sector === undefined) {
      continue;
    }
    const list = bySector.get(stock.sector) ?? [];
    list.push(stock);
    bySector.set(stock.sector, list);
  }

  const isStrong = (stock: UniverseStock): boolean =>
    classifyLimitState(stock.symbol, stock.changePct) === "limit_up" ||
    (stock.changePct !== undefined && stock.changePct >= HOT_SECTOR_STRONG_PCT);

  return [...bySector.entries()]
    .map(([sector, stocks]) => ({ sector, stocks, heat: stocks.filter(isStrong).length }))
    .filter((entry) => entry.heat >= HOT_SECTOR_MIN_STRONG)
    .sort((left, right) => right.heat - left.heat || left.sector.localeCompare(right.sector))
    .map((entry) => [...entry.stocks].sort(byAmountDesc)[0])
    .filter((stock): stock is UniverseStock => stock !== undefined);
}

/** Buckets that get named (层级2) in the overview; amount_top is filler → count only. */
const NAMED_BUCKETS: readonly PoolBucket[] = [
  "position",
  "limit_up",
  "limit_down",
  "yesterday_limit_up",
  "yesterday_limit_down",
  "hot_sector_leader",
  "change_top",
];

/**
 * Renders the OpenClaw-style progressive-disclosure overview of a categorized pool:
 * 层级1 (category counts) + 层级2 (named picks per informative bucket, with 涨跌幅).
 * Pure — same pool, same text. Fed to the brain so the push can say "观察池 N 只：
 * 涨停 a、昨日涨停 b…" with concrete names instead of a flat list.
 */
export function renderPoolOverview(
  entries: readonly CategorizedPoolEntry[],
  options: { namesPerBucket?: number; sealBySymbol?: ReadonlyMap<string, SealBoard> } = {},
): string {
  if (entries.length === 0) {
    return "";
  }
  const namesPerBucket = options.namesPerBucket ?? 8;
  const byBucket = poolByBucket(entries);

  const counts = BUCKET_PRIORITY.map((bucket) => {
    const count = byBucket.get(bucket)?.length ?? 0;
    return count > 0 ? `${POOL_BUCKET_LABEL[bucket]}${count}` : undefined;
  }).filter((part): part is string => part !== undefined);

  const lines = [`观察池 ${entries.length} 只（${counts.join("·")}）。`];

  const capitalLine = renderCapitalFlowLine(entries);
  if (capitalLine) {
    lines.push(capitalLine);
  }

  for (const bucket of NAMED_BUCKETS) {
    const bucketEntries = byBucket.get(bucket) ?? [];
    if (bucketEntries.length === 0) {
      continue;
    }
    const names = bucketEntries
      .slice(0, namesPerBucket)
      // Include the REAL code (anti-hallucination) + 封单 tag for limit boards.
      .map((entry) => {
        const seal = options.sealBySymbol?.get(entry.stock.symbol);
        const sealTag = seal ? ` ${renderSealTag(seal)}` : "";
        return `${entry.stock.name}(${entry.stock.symbol}${formatChange(entry.stock.changePct)}${sealTag})`;
      })
      .join("、");
    const more = bucketEntries.length > namesPerBucket ? ` 等${bucketEntries.length}只` : "";
    lines.push(`${POOL_BUCKET_LABEL[bucket]}：${names}${more}`);
  }

  return lines.join("\n");
}

function formatChange(changePct: number | undefined): string {
  if (changePct === undefined) {
    return "";
  }
  const sign = changePct > 0 ? "+" : "";
  return ` ${sign}${changePct.toFixed(2)}%`;
}

/**
 * 资金面 line — the 北向资金 replacement: pool-wide 主力净流入 total + the strongest
 * 净流入 names. Returns "" when no entry carries 主力净流入 (source didn't provide it).
 */
function renderCapitalFlowLine(entries: readonly CategorizedPoolEntry[]): string {
  const withFlow = entries.filter((entry) => entry.stock.mainNetInflow !== undefined);
  if (withFlow.length === 0) {
    return "";
  }
  const total = withFlow.reduce((sum, entry) => sum + (entry.stock.mainNetInflow ?? 0), 0);
  const topInflow = [...withFlow]
    .sort((left, right) => (right.stock.mainNetInflow ?? 0) - (left.stock.mainNetInflow ?? 0))
    .filter((entry) => (entry.stock.mainNetInflow ?? 0) > 0)
    .slice(0, 5)
    .map((entry) => `${entry.stock.name}(${entry.stock.symbol} ${formatYi(entry.stock.mainNetInflow ?? 0)})`)
    .join("、");
  const head = `资金面：池内主力净流入合计 ${formatYi(total)}`;
  return topInflow ? `${head}；净流入前${Math.min(5, withFlow.filter((e) => (e.stock.mainNetInflow ?? 0) > 0).length)}：${topInflow}` : head;
}

/** Formats a yuan amount as a signed 亿 string, e.g. +5.20亿 / -1.30亿. */
function formatYi(yuan: number): string {
  const sign = yuan > 0 ? "+" : yuan < 0 ? "-" : "";
  return `${sign}${(Math.abs(yuan) / 1e8).toFixed(2)}亿`;
}

/** Group a categorized pool into bucket → entries (positions never dropped). */
export function poolByBucket(
  entries: readonly CategorizedPoolEntry[],
): Map<PoolBucket, CategorizedPoolEntry[]> {
  const map = new Map<PoolBucket, CategorizedPoolEntry[]>();
  for (const bucket of BUCKET_PRIORITY) {
    map.set(bucket, []);
  }
  for (const entry of entries) {
    map.get(entry.bucket)?.push(entry);
  }
  return map;
}

/** Keep positions plus the first (maxTotal − positionCount) of the rest, preserving order. */
function capPool(entries: CategorizedPoolEntry[], maxTotal: number): CategorizedPoolEntry[] {
  if (entries.length <= maxTotal) {
    return entries;
  }
  const positions = entries.filter((entry) => entry.bucket === "position");
  const rest = entries.filter((entry) => entry.bucket !== "position");
  const room = Math.max(0, maxTotal - positions.length);
  return [...positions, ...rest.slice(0, room)];
}

function passesAmount(stock: UniverseStock, minAmount: number): boolean {
  if (minAmount <= 0) {
    return true;
  }
  return stock.amount !== undefined && stock.amount >= minAmount;
}

function byAmountDesc(left: UniverseStock, right: UniverseStock): number {
  return byNumberDesc(left.amount, right.amount, left, right);
}

function byNumberDesc(
  leftValue: number | undefined,
  rightValue: number | undefined,
  left: UniverseStock,
  right: UniverseStock,
): number {
  if (leftValue === undefined && rightValue === undefined) {
    return left.symbol.localeCompare(right.symbol);
  }
  if (leftValue === undefined) {
    return 1;
  }
  if (rightValue === undefined) {
    return -1;
  }
  const diff = rightValue - leftValue;
  return diff !== 0 ? diff : left.symbol.localeCompare(right.symbol);
}
