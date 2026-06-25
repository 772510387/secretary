import {
  softExperienceReportSchema,
  type ExperienceRangeBucket,
  type ExperienceVerdict,
  type ReplayBias,
  type ScoredDecision,
  type SoftExperienceReport,
  type SoftLesson,
} from "../domain/decision/index.js";

export interface DistillExperienceInput {
  scored: ScoredDecision[];
  startDate: string;
  endDate: string;
  horizonTradingDays: number;
  returnThreshold: number;
  /** Below this many scored stances a regime stays "insufficient" (default 3). */
  minSamples?: number;
}

const DEFAULT_MIN_SAMPLES = 3;

type DecisionTrend = SoftLesson["regime"]["trend"];

interface RegimeAccumulator {
  trend: DecisionTrend;
  rangeBucket: ExperienceRangeBucket;
  bias: ReplayBias;
  sampleSize: number;
  hits: number;
  returnSum: number;
}

/**
 * Distills retrospectively-scored decisions into soft, advisory lessons grouped by
 * market regime (trend × 60-day-range bucket × bias). Deterministic. The output is
 * ADVISORY ONLY — a soft hint for future judgement, never a hard-rule change.
 *
 * NOTE: a window's lessons are derived from that window's realized outcomes, so they
 * must NOT be fed back into decisions within the same window (that would be aggregate
 * look-ahead). Feeding prior-period lessons forward, behind a temporal fence, is P1.2.
 */
export function distillSoftExperience(input: DistillExperienceInput): SoftExperienceReport {
  const minSamples = input.minSamples ?? DEFAULT_MIN_SAMPLES;
  const groups = new Map<string, RegimeAccumulator>();
  let scoredStances = 0;
  let coverageThroughDate: string | null = null;

  for (const decision of input.scored) {
    for (const stance of decision.stances) {
      if (!stance.forwardOutcome.realized || stance.forwardOutcome.forwardReturn === null) {
        continue;
      }
      scoredStances += 1;
      // Track the latest date by which this report's knowledge was observable — the
      // fence a future decision must clear before it may use this experience.
      const toDate = stance.forwardOutcome.toDate;
      if (toDate !== null && (coverageThroughDate === null || toDate > coverageThroughDate)) {
        coverageThroughDate = toDate;
      }
      const rangeBucket = bucketOf(stance.basis.rangePosition60);
      const key = `${stance.basis.trend}|${rangeBucket}|${stance.bias}`;
      const group = groups.get(key) ?? {
        trend: stance.basis.trend,
        rangeBucket,
        bias: stance.bias,
        sampleSize: 0,
        hits: 0,
        returnSum: 0,
      };
      group.sampleSize += 1;
      if (stance.correct === true) {
        group.hits += 1;
      }
      group.returnSum += stance.forwardOutcome.forwardReturn;
      groups.set(key, group);
    }
  }

  const lessons: SoftLesson[] = [...groups.values()]
    .map((group) => {
      const hitRate = group.sampleSize > 0 ? round6(group.hits / group.sampleSize) : null;
      const avgForwardReturn = group.sampleSize > 0 ? round6(group.returnSum / group.sampleSize) : null;
      const verdict = classifyVerdict(group.sampleSize, hitRate, minSamples);
      return {
        regime: { trend: group.trend, rangeBucket: group.rangeBucket, bias: group.bias },
        sampleSize: group.sampleSize,
        hits: group.hits,
        hitRate,
        avgForwardReturn,
        verdict,
        advice: buildAdvice(group, hitRate, avgForwardReturn, verdict),
      };
    })
    .sort(byRegime);

  return softExperienceReportSchema.parse({
    schemaVersion: 1,
    startDate: input.startDate,
    endDate: input.endDate,
    horizonTradingDays: input.horizonTradingDays,
    returnThreshold: input.returnThreshold,
    decisionsAnalyzed: input.scored.length,
    scoredStances,
    coverageThroughDate,
    advisoryOnly: true,
    generatedBy: "soft-experience-distiller",
    lessons,
  });
}

/** Soft lookup for P1.2: find the lesson matching a regime (or null). Advisory only. */
export function findSoftLesson(
  report: SoftExperienceReport,
  regime: { trend: DecisionTrend; rangePosition60: number | null; bias: ReplayBias },
): SoftLesson | null {
  const rangeBucket = bucketOf(regime.rangePosition60);
  return (
    report.lessons.find(
      (lesson) =>
        lesson.regime.trend === regime.trend &&
        lesson.regime.rangeBucket === rangeBucket &&
        lesson.regime.bias === regime.bias,
    ) ?? null
  );
}

/** All lessons for a (trend, range-bucket) regime — the bias variants seen historically. */
export function findSoftLessonsByRegime(
  report: SoftExperienceReport,
  regime: { trend: DecisionTrend; rangePosition60: number | null },
): SoftLesson[] {
  const rangeBucket = bucketOf(regime.rangePosition60);
  return report.lessons.filter(
    (lesson) => lesson.regime.trend === regime.trend && lesson.regime.rangeBucket === rangeBucket,
  );
}

/**
 * The temporal fence: a decision at `asOfDate` may use this experience ONLY if all of
 * its knowledge was observable strictly before then. Returns false for an empty or
 * future-overlapping report — preventing a window's own future from informing its past.
 */
export function isExperienceUsableAt(report: SoftExperienceReport, asOfDate: string): boolean {
  return report.coverageThroughDate !== null && report.coverageThroughDate < asOfDate;
}

export function bucketOf(rangePosition60: number | null): ExperienceRangeBucket {
  if (rangePosition60 === null) {
    return "unknown";
  }
  if (rangePosition60 < 0.33) {
    return "low";
  }
  if (rangePosition60 < 0.66) {
    return "mid";
  }
  if (rangePosition60 < 0.85) {
    return "high";
  }
  return "near_high";
}

function classifyVerdict(
  sampleSize: number,
  hitRate: number | null,
  minSamples: number,
): ExperienceVerdict {
  if (sampleSize < minSamples || hitRate === null) {
    return "insufficient";
  }
  if (hitRate >= 0.6) {
    return "favorable";
  }
  if (hitRate <= 0.4) {
    return "unfavorable";
  }
  return "mixed";
}

const TREND_LABEL: Record<DecisionTrend, string> = {
  uptrend: "上涨",
  downtrend: "下跌",
  sideways: "震荡",
  insufficient_data: "数据不足",
};
const BUCKET_LABEL: Record<ExperienceRangeBucket, string> = {
  low: "低位",
  mid: "中位",
  high: "高位",
  near_high: "逼近高位",
  unknown: "位置未知",
};
const BIAS_LABEL: Record<ReplayBias, string> = {
  increase: "加配",
  hold: "保持",
  reduce: "减配",
};
const VERDICT_ADVICE: Record<ExperienceVerdict, string> = {
  favorable: "该判断在此形态下较可靠，可作正向软提示。",
  unfavorable: "该判断在此形态下表现差，建议人工复核是否调整策略。",
  mixed: "表现一般，暂无明显优势。",
  insufficient: "样本不足，暂不形成结论。",
};

function buildAdvice(
  group: RegimeAccumulator,
  hitRate: number | null,
  avgForwardReturn: number | null,
  verdict: ExperienceVerdict,
): string {
  return `在【${TREND_LABEL[group.trend]}·${BUCKET_LABEL[group.rangeBucket]}】形态下对“${BIAS_LABEL[group.bias]}”：命中率 ${pct(hitRate)}、平均前瞻收益 ${pct(avgForwardReturn)}（样本 ${group.sampleSize}）。${VERDICT_ADVICE[verdict]}`;
}

const TREND_ORDER: DecisionTrend[] = ["uptrend", "downtrend", "sideways", "insufficient_data"];
const BUCKET_ORDER: ExperienceRangeBucket[] = ["low", "mid", "high", "near_high", "unknown"];
const BIAS_ORDER: ReplayBias[] = ["increase", "hold", "reduce"];

function byRegime(left: SoftLesson, right: SoftLesson): number {
  return (
    TREND_ORDER.indexOf(left.regime.trend) - TREND_ORDER.indexOf(right.regime.trend) ||
    BUCKET_ORDER.indexOf(left.regime.rangeBucket) - BUCKET_ORDER.indexOf(right.regime.rangeBucket) ||
    BIAS_ORDER.indexOf(left.regime.bias) - BIAS_ORDER.indexOf(right.regime.bias)
  );
}

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
