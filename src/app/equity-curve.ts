import {
  equityCurveSchema,
  type EquityCurve,
  type EquityPoint,
  type ScoredDecision,
} from "../domain/decision/index.js";

/**
 * Computes a PROXY strategy equity curve from scored decisions. Each realized stance
 * contributes a signed forward return by bias (increase → +r, reduce → −r, hold → 0);
 * per trading date the signals are averaged, then compounded into an equity index
 * (start = 1). It also reports max drawdown. This is a directional-quality gauge, NOT a
 * real-money P&L (no position sizing, no costs) — useful for comparing deciders, not
 * for claiming returns.
 */
export function computeEquityCurve(scored: ScoredDecision[]): EquityCurve {
  const signalsByDate = new Map<string, number[]>();

  for (const decision of scored) {
    for (const stance of decision.stances) {
      if (!stance.forwardOutcome.realized || stance.forwardOutcome.forwardReturn === null) {
        continue;
      }
      const forwardReturn = stance.forwardOutcome.forwardReturn;
      const signed =
        stance.bias === "increase" ? forwardReturn : stance.bias === "reduce" ? -forwardReturn : 0;
      const list = signalsByDate.get(decision.asOfDate) ?? [];
      list.push(signed);
      signalsByDate.set(decision.asOfDate, list);
    }
  }

  const dates = [...signalsByDate.keys()].sort();
  const points: EquityPoint[] = [];
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;

  for (const date of dates) {
    const signals = signalsByDate.get(date)!;
    const rawSignal = signals.reduce((sum, value) => sum + value, 0) / signals.length;
    // Floor the per-date signal so the equity index stays positive. A signal below
    // -100% is a proxy artifact (e.g. "reduce" while the stock more than doubled);
    // without this, equity could flip negative and drawdown exceed 1.
    const signal = round6(Math.max(rawSignal, SIGNAL_FLOOR));
    equity = round6(equity * (1 + signal));
    if (equity > peak) {
      peak = equity;
    }
    if (peak > 0) {
      maxDrawdown = Math.min(1, Math.max(maxDrawdown, round6((peak - equity) / peak)));
    }
    points.push({ date, signal, equity });
  }

  return equityCurveSchema.parse({
    schemaVersion: 1,
    startEquity: 1,
    endEquity: equity,
    totalReturn: round6(equity - 1),
    maxDrawdown,
    tradingDays: dates.length,
    points,
  });
}

/** Per-date signal floor — keeps the equity index strictly positive (1 + signal >= 0.01). */
const SIGNAL_FLOOR = -0.99;

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
