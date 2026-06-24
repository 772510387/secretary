import { calculatePortfolioValuation, type Account, type Position } from "../domain/portfolio/index.js";

export interface DataWarmupCheckInput {
  account: Account | null;
  positions: Position[];
  watchlistCount: number;
}

export interface DataWarmupCheck {
  accountPresent: boolean;
  positionsCount: number;
  watchlistCount: number;
  cashAvailable: number | null;
  totalCostBasis: number | null;
  /** True when no readiness note fired (ledger present, pool non-empty). */
  ok: boolean;
  notes: string[];
}

/**
 * PRE-01: deterministic 08:00 体检 (local self-check, no network — the data_warmup SOP
 * forbids live fetches). Confirms the paper ledger is present/readable and the 100池 is
 * populated, and surfaces cash + cost basis so a missing/zeroed account is caught early.
 * Pure: same inputs -> same output. The brain is never asked to "check if data is there".
 */
export function runDataWarmupSelfCheck(input: DataWarmupCheckInput): DataWarmupCheck {
  const notes: string[] = [];

  if (!input.account) {
    notes.push("模拟盘账户缺失或不可读");
  }
  if (input.watchlistCount === 0) {
    notes.push("100支高关注池为空（尚未换血或筛选失败）");
  }

  let cashAvailable: number | null = null;
  let totalCostBasis: number | null = null;
  if (input.account) {
    cashAvailable = input.account.cash.available;
    totalCostBasis = calculatePortfolioValuation(input.account, input.positions).totalCostBasis;
  }

  return {
    accountPresent: input.account !== null,
    positionsCount: input.positions.length,
    watchlistCount: input.watchlistCount,
    cashAvailable,
    totalCostBasis,
    ok: notes.length === 0,
    notes,
  };
}
