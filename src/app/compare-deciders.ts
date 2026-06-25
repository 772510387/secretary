import {
  deciderComparisonReportSchema,
  type DeciderComparisonReport,
  type DeciderStrategyResult,
} from "../domain/decision/index.js";
import type { PointInTimeSnapshot } from "../domain/portfolio/index.js";
import { scoreReplaySnapshots, type ScoreOptions } from "./score-replay.js";
import { ForwardOutcomeReader } from "./forward-outcome-reader.js";
import type { ReplayDecider } from "./replay-decider.js";

export interface DeciderStrategy {
  name: string;
  decider: ReplayDecider;
}

export interface CompareDecidersInput extends ScoreOptions {
  snapshots: PointInTimeSnapshot[];
  strategies: DeciderStrategy[];
  forwardReader: ForwardOutcomeReader;
  startDate: string;
  endDate: string;
}

/**
 * Scores the SAME snapshots through several named decider strategies and reports each
 * one's scorecard, plus the best by hit rate. The point: see whether the model — and
 * especially the experience-fed model — actually beats the deterministic baseline on
 * identical inputs. Read-only; every strategy's decisions stay non-executable.
 */
export async function compareDeciders(
  input: CompareDecidersInput,
): Promise<DeciderComparisonReport> {
  const strategies: DeciderStrategyResult[] = [];

  for (const strategy of input.strategies) {
    const scored = await scoreReplaySnapshots({
      snapshots: input.snapshots,
      decider: strategy.decider,
      forwardReader: input.forwardReader,
      startDate: input.startDate,
      endDate: input.endDate,
      horizonTradingDays: input.horizonTradingDays,
      returnThreshold: input.returnThreshold,
    });
    strategies.push({
      name: strategy.name,
      decisionsCount: scored.scorecard.decisionsCount,
      scoredStances: scored.scorecard.scoredStances,
      hitRate: scored.scorecard.hitRate,
      avgForwardReturn: scored.scorecard.avgForwardReturn,
    });
  }

  return deciderComparisonReportSchema.parse({
    schemaVersion: 1,
    startDate: input.startDate,
    endDate: input.endDate,
    horizonTradingDays: input.horizonTradingDays,
    returnThreshold: input.returnThreshold,
    strategies,
    best: pickBest(strategies),
    advisoryOnly: true,
  });
}

type ScoredStrategy = DeciderStrategyResult & { hitRate: number };

function pickBest(strategies: DeciderStrategyResult[]): string | null {
  const eligible = strategies.filter(
    (strategy): strategy is ScoredStrategy => strategy.scoredStances > 0 && strategy.hitRate !== null,
  );
  if (eligible.length === 0) {
    return null;
  }
  // Rank: hit rate desc, then avg forward return desc, then name asc (deterministic tie-break).
  const sorted = [...eligible].sort(
    (left, right) =>
      right.hitRate - left.hitRate ||
      (right.avgForwardReturn ?? 0) - (left.avgForwardReturn ?? 0) ||
      left.name.localeCompare(right.name),
  );
  return sorted[0]!.name;
}
