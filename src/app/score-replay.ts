import {
  replayDecisionSchema,
  replayScorecardSchema,
  scoredDecisionSchema,
  type ForwardOutcome,
  type ReplayBias,
  type ReplayDecision,
  type ReplayScorecard,
  type ScoredDecision,
  type ScoredStance,
} from "../domain/decision/index.js";
import type { PointInTimeSnapshot } from "../domain/portfolio/index.js";
import { deterministicReplayDecider, type ReplayDecider } from "./replay-decider.js";
import { ForwardOutcomeReader } from "./forward-outcome-reader.js";

export interface ScoreOptions {
  horizonTradingDays: number;
  returnThreshold: number;
}

/** Structural writer so this layer needn't depend on the concrete storage class. */
export interface ScoredDecisionWriter {
  writeDecision(decision: ScoredDecision): unknown;
}

export interface ScoreReplayInput extends ScoreOptions {
  snapshots: PointInTimeSnapshot[];
  forwardReader: ForwardOutcomeReader;
  startDate: string;
  endDate: string;
  /** Decision strategy (deterministic or model). Defaults to the deterministic rule. */
  decider?: ReplayDecider;
  store?: ScoredDecisionWriter;
}

export interface ScoreReplayResult {
  scored: ScoredDecision[];
  scorecard: ReplayScorecard;
}

/**
 * Scores each replayed snapshot: make the as-of decision, then evaluate it against
 * the realized forward outcome (the fenced look-ahead). Only symbols that had a
 * genuine as-of market close are scoreable; degraded / cost-fallback symbols are
 * left unrealized (never scored against a non-market anchor).
 */
export async function scoreReplaySnapshots(input: ScoreReplayInput): Promise<ScoreReplayResult> {
  const decider = input.decider ?? deterministicReplayDecider;
  const scored: ScoredDecision[] = [];

  for (const snapshot of input.snapshots) {
    const decision = await decider.decide(snapshot);
    const outcomes = new Map<string, ForwardOutcome>();

    for (const stance of decision.stances) {
      const priceSource = snapshot.market.priceSources[stance.symbol];
      if (priceSource?.source === "as_of_close" && priceSource.tradeDate !== undefined) {
        const fromClose = snapshot.market.prices[stance.symbol]!;
        outcomes.set(
          stance.symbol,
          await input.forwardReader.getForwardOutcome({
            symbol: { symbol: stance.symbol, market: stance.market },
            // Anchor the forward window on the as-of bar date (the close the decision
            // saw), NOT the snapshot's calendar date — so a horizon is exactly N
            // trading days from the bar the decision was made against.
            fromDate: priceSource.tradeDate,
            fromClose,
            horizonTradingDays: input.horizonTradingDays,
          }),
        );
      } else {
        // No as-of market anchor (degraded / cost-fallback) → not scoreable.
        outcomes.set(stance.symbol, unrealizedOutcome(input.horizonTradingDays));
      }
    }

    const scoredDecision = scoreDecision(decision, outcomes, {
      horizonTradingDays: input.horizonTradingDays,
      returnThreshold: input.returnThreshold,
    });
    input.store?.writeDecision(scoredDecision);
    scored.push(scoredDecision);
  }

  return {
    scored,
    scorecard: summarizeScoredDecisions(scored, input),
  };
}

/** Pure scorer: combine an as-of decision with realized forward outcomes. */
export function scoreDecision(
  decisionInput: ReplayDecision,
  outcomes: Map<string, ForwardOutcome>,
  options: ScoreOptions,
): ScoredDecision {
  // Re-validate at the trust boundary: this is a public API, so don't rely on the
  // (erased) TS type to guarantee a well-formed, decider-produced decision.
  const decision = replayDecisionSchema.parse(decisionInput);
  const stances: ScoredStance[] = decision.stances.map((stance) => {
    const outcome = outcomes.get(stance.symbol) ?? unrealizedOutcome(options.horizonTradingDays);
    return {
      ...stance,
      forwardOutcome: outcome,
      correct: scoreStance(stance.bias, outcome, options.returnThreshold),
    };
  });

  const realized = stances.filter((stance) => stance.forwardOutcome.realized);
  const hits = realized.filter((stance) => stance.correct === true).length;

  return scoredDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: decision.decisionId,
    snapshotId: decision.snapshotId,
    accountId: decision.accountId,
    alarmId: decision.alarmId,
    asOfDate: decision.asOfDate,
    asOfTime: decision.asOfTime,
    horizonTradingDays: options.horizonTradingDays,
    returnThreshold: options.returnThreshold,
    stances,
    summary: {
      scoredCount: realized.length,
      hitCount: hits,
      hitRate: realized.length > 0 ? round6(hits / realized.length) : null,
      avgForwardReturn: averageForwardReturn(realized),
    },
    executable: false,
    reviewRequired: true,
    generatedBy: decision.generatedBy,
    scoredBy: "forward-return-scorer",
  });
}

function scoreStance(
  bias: ReplayBias,
  outcome: ForwardOutcome,
  threshold: number,
): boolean | null {
  if (!outcome.realized || outcome.forwardReturn === null) {
    return null;
  }
  const forwardReturn = outcome.forwardReturn;
  if (bias === "increase") {
    return forwardReturn > threshold;
  }
  if (bias === "reduce") {
    return forwardReturn < -threshold;
  }
  return Math.abs(forwardReturn) <= threshold; // hold
}

/** Aggregate a set of scored decisions into a single scorecard (also used by walk-forward). */
export function summarizeScoredDecisions(
  scored: ScoredDecision[],
  input: { startDate: string; endDate: string } & ScoreOptions,
): ReplayScorecard {
  const allStances = scored.flatMap((decision) => decision.stances);
  const realized = allStances.filter((stance) => stance.forwardOutcome.realized);
  const hits = realized.filter((stance) => stance.correct === true).length;

  return replayScorecardSchema.parse({
    schemaVersion: 1,
    startDate: input.startDate,
    endDate: input.endDate,
    horizonTradingDays: input.horizonTradingDays,
    returnThreshold: input.returnThreshold,
    decisionsCount: scored.length,
    scoredStances: realized.length,
    hitStances: hits,
    hitRate: realized.length > 0 ? round6(hits / realized.length) : null,
    avgForwardReturn: averageForwardReturn(realized),
    byBias: {
      increase: biasBreakdown(realized, "increase"),
      hold: biasBreakdown(realized, "hold"),
      reduce: biasBreakdown(realized, "reduce"),
    },
  });
}

function biasBreakdown(realizedStances: ScoredStance[], bias: ReplayBias) {
  const subset = realizedStances.filter((stance) => stance.bias === bias);
  const hits = subset.filter((stance) => stance.correct === true).length;
  return {
    scored: subset.length,
    hits,
    hitRate: subset.length > 0 ? round6(hits / subset.length) : null,
    avgForwardReturn: averageForwardReturn(subset),
  };
}

function averageForwardReturn(stances: ScoredStance[]): number | null {
  if (stances.length === 0) {
    return null;
  }
  const total = stances.reduce((sum, stance) => sum + (stance.forwardOutcome.forwardReturn ?? 0), 0);
  return round6(total / stances.length);
}

function unrealizedOutcome(horizonTradingDays: number): ForwardOutcome {
  return {
    horizonTradingDays,
    fromDate: null,
    fromClose: null,
    realized: false,
    toDate: null,
    toClose: null,
    forwardReturn: null,
  };
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
