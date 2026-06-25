import {
  dailyTradingPlanSchema,
  type DailyTradingPlan,
  type PlanPendingOrder,
  type PlanShortlistEntry,
  type PlanWatchlistEntry,
} from "./schemas.js";
import type { WatchlistEntry } from "../market/index.js";

export interface BuildDailyTradingPlanInput {
  tradingDate: string;
  accountId: string;
  alarmType: string;
  generatedAt: string;
  autoPaper?: boolean;
  watchlist100: PlanWatchlistEntry[];
  shortlist10?: PlanShortlistEntry[];
  pendingOrders?: PlanPendingOrder[];
  planId?: string;
}

export interface ReviseWithNodeInput {
  alarmType: string;
  generatedAt: string;
  watchlist100?: PlanWatchlistEntry[];
  shortlist10?: PlanShortlistEntry[];
  pendingOrders?: PlanPendingOrder[];
}

/**
 * Copies the live 100-pool watchlist entries into a lean, immutable plan snapshot. We copy
 * (not reference) so a later node's decision is reproducible against the pool it actually saw
 * — the watchlist file is re-screened/mutated during the day.
 */
export function snapshotWatchlist(entries: readonly WatchlistEntry[]): PlanWatchlistEntry[] {
  return entries.map((entry) => ({
    symbol: entry.symbol,
    market: entry.market,
    name: entry.name,
    rank: typeof entry.metadata.rank === "number" ? entry.metadata.rank : null,
  }));
}

/** Deterministic fallback: take the top-N of the pool by rank when the model output is unusable. */
export function selectTopNByRank(watchlist: PlanWatchlistEntry[], n: number): PlanShortlistEntry[] {
  return [...watchlist]
    .sort((left, right) => (left.rank ?? Number.POSITIVE_INFINITY) - (right.rank ?? Number.POSITIVE_INFINITY))
    .slice(0, n)
    .map((entry) => ({
      symbol: entry.symbol,
      market: entry.market,
      name: entry.name,
      rank: entry.rank,
      rationale: "降级：模型未给出可用候选，按成交额排名取 top-N。",
    }));
}

export function buildDailyTradingPlan(input: BuildDailyTradingPlanInput): DailyTradingPlan {
  return dailyTradingPlanSchema.parse({
    schemaVersion: 1,
    planId: input.planId ?? `plan-${input.tradingDate}-${input.accountId}`,
    tradingDate: input.tradingDate,
    accountId: input.accountId,
    nodeSequence: 0,
    alarmType: input.alarmType,
    generatedAt: input.generatedAt,
    watchlist100: input.watchlist100,
    shortlist10: input.shortlist10 ?? [],
    pendingOrders: input.pendingOrders ?? [],
    safety: { liveTrading: false, autoPaper: input.autoPaper ?? false },
    metadata: {},
  });
}

/** Produce the next node's revision (bumps nodeSequence; unspecified layers carry over). */
export function reviseWithNode(plan: DailyTradingPlan, input: ReviseWithNodeInput): DailyTradingPlan {
  return dailyTradingPlanSchema.parse({
    ...plan,
    nodeSequence: plan.nodeSequence + 1,
    alarmType: input.alarmType,
    generatedAt: input.generatedAt,
    watchlist100: input.watchlist100 ?? plan.watchlist100,
    shortlist10: input.shortlist10 ?? plan.shortlist10,
    pendingOrders: input.pendingOrders ?? plan.pendingOrders,
  });
}
